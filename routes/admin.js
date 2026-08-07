/**
 * 权限管理路由
 * 所有接口需要 requireAuth + requireRole('admin', 'super_admin')
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const db = require('../db');
const log = require('../logger');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getDiscordToken, ENV_PATH, loadChannels, fmtCST8 } = require('../config');
const sentiment = require('../sentiment');

// Discord 服务器列表
const SERVERS = [
  { key: 'TC',  label: '繁中服', envKey: 'DISCORD_TC_BOT_TOKEN' },
  { key: 'JP',  label: '日服',   envKey: 'DISCORD_JP_BOT_TOKEN' },
  { key: 'SEA', label: '东南亚服', envKey: 'DISCORD_SEA_BOT_TOKEN' },
  { key: 'KR',  label: '韩服',   envKey: 'DISCORD_KR_BOT_TOKEN' },
];

// 频道 JSON 文件路径
const CHANNELS_JSON = path.join(__dirname, '..', 'dc-publish-channels.json');

router.use('/api/admin', requireAuth);

// ===== 初始化洞察报告存档表（延迟初始化，等待 db.initDb 完成）=====
let insightsTableReady = false;
function ensureInsightsTable() {
  if (insightsTableReady) return;
  try {
    const dbConn = db.getDb();
    if (!dbConn) return;
    dbConn.run(`
      CREATE TABLE IF NOT EXISTS insights_reports (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        period          TEXT NOT NULL,
        content         TEXT NOT NULL,
        twitter_count   INTEGER DEFAULT 0,
        discord_count   INTEGER DEFAULT 0,
        total_records   INTEGER DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
      )
    `);
    dbConn.run('CREATE INDEX IF NOT EXISTS idx_insights_created ON insights_reports(created_at DESC)');
    // 迁移：添加 lounge_count 列（旧表可能没有）
    try { dbConn.run('ALTER TABLE insights_reports ADD COLUMN lounge_count INTEGER DEFAULT 0'); } catch(_) {}
    db.saveDb();
    insightsTableReady = true;
  } catch (e) {
    console.error('❌ 初始化洞察报告表失败:', e.message);
  }
}

// 获取有效角色列表
router.get('/api/admin/roles', requireRole('admin', 'super_admin'), (req, res) => {
  res.json({ ok: true, data: db.VALID_ROLES });
});

// 获取所有用户列表（仅管理员）
router.get('/api/admin/users', requireRole('admin', 'super_admin'), (req, res) => {
  try {
    const users = db.getAllUsers();
    res.json({ ok: true, data: users });
  } catch (e) {
    log.error('获取用户列表失败', e.message);
    res.status(500).json({ error: `获取失败: ${e.message}` });
  }
});

// 设置用户角色（admin + super_admin）
router.put('/api/admin/users/:username/role', requireRole('admin', 'super_admin'), (req, res) => {
  const operator = req.user.username;
  try {
    const { username } = req.params;
    const { role } = req.body;
    if (!db.VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: '无效的角色，可选: ' + db.VALID_ROLES.join(', ') });
    }
    // admin 不能设置 super_admin 角色
    if (role === 'super_admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: '只有超级管理员才能设置 super_admin 角色' });
    }
    if (!db.userExists(username)) {
      return res.status(404).json({ error: '用户不存在' });
    }
    db.setUserRole(username, role);
    log.info(`管理员 ${operator} 将用户 ${username} 的角色设置为 ${role}`);
    res.json({ ok: true, message: '角色更新成功' });
  } catch (e) {
    log.error('设置用户角色失败', e.message);
    res.status(500).json({ error: `设置失败: ${e.message}` });
  }
});

// ===== 用户扩展权限管理 =====

// 获取用户权限
router.get('/api/admin/users/:username/permissions', requireRole('admin', 'super_admin'), (req, res) => {
  const { username } = req.params;
  try {
    const perms = db.getUserPermissions(username);
    res.json({ ok: true, data: perms });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 设置用户权限（上传权限 + 地区限制 + 贴文助手）
router.put('/api/admin/users/:username/permissions', requireRole('admin', 'super_admin'), (req, res) => {
  const { username } = req.params;
  const { upload, regions, postAssistant } = req.body;
  try {
    const currentPerms = db.getUserPermissions(username);
    const newPerms = {
      upload: typeof upload === 'boolean' ? upload : currentPerms.upload,
      regions: Array.isArray(regions) ? regions : currentPerms.regions,
      postAssistant: typeof postAssistant === 'boolean' ? postAssistant : currentPerms.postAssistant,
    };
    db.setUserPermissions(username, newPerms);
    log.info(`[权限设置] ${req.user.username} 设置 ${username} 权限: upload=${newPerms.upload}, regions=${JSON.stringify(newPerms.regions)}, postAssistant=${newPerms.postAssistant}`);
    res.json({ ok: true, message: '权限更新成功', data: newPerms });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 删除用户（仅 super_admin）
router.delete('/api/admin/users/:username', requireRole('super_admin'), (req, res) => {
  const operator = req.user.username;
  try {
    const { username } = req.params;
    if (username === operator) {
      return res.status(400).json({ error: '不能删除自己' });
    }
    if (!db.userExists(username)) {
      return res.status(404).json({ error: '用户不存在' });
    }
    db.deleteUser(username);
    log.info(`超级管理员 ${operator} 删除了用户 ${username}`);
    res.json({ ok: true, message: '用户已删除' });
  } catch (e) {
    log.error('删除用户失败', e.message);
    res.status(500).json({ error: `删除失败: ${e.message}` });
  }
});

// ===== Token 管理 API =====

// 获取所有 Token（脱敏显示）
router.get('/api/admin/tokens', requireRole('admin', 'super_admin'), (req, res) => {
  try {
    const tokens = SERVERS.map(s => {
      const token = getDiscordToken(s.key);
      if (!token) return { server: s.key, label: s.label, masked: '未配置', has: false };
      const head = token.substring(0, 5);
      const tail = token.substring(token.length - 5);
      return { server: s.key, label: s.label, masked: `${head}...${tail}`, has: true, length: token.length };
    });
    res.json({ ok: true, data: tokens });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 测试单个 Token 健康度
router.post('/api/admin/tokens/test', requireRole('admin', 'super_admin'), async (req, res) => {
  const { server } = req.body;
  if (!SERVERS.find(s => s.key === server)) {
    return res.status(400).json({ error: '无效的服务器标识' });
  }
  const token = getDiscordToken(server);
  if (!token) return res.json({ ok: false, status: 'empty', message: 'Token 未配置' });

  try {
    // 1. 验证 Bot 身份
    const me = await axios.get('https://discord.com/api/v10/users/@me', {
      headers: { 'Authorization': 'Bot ' + token },
      timeout: 30000,
    });
    const botName = me.data.username;
    // 2. 简单发一条测试消息到测试频道并撤回
    const testChannels = { TC: '1435902837921021962', JP: '1412077043759190117', SEA: '1514193499363217428', KR: '1508721766606962759' };
    const chId = testChannels[server];
    let sendOk = false;
    let msgId = null;
    try {
      const sendRes = await axios.post(
        `https://discord.com/api/v10/channels/${chId}/messages`,
        { content: `[Health Check] ${fmtCST8(new Date())}` },
        { headers: { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      sendOk = true;
      msgId = sendRes.data?.id;
    } catch (_) {}
    // 撤回
    if (msgId) {
      try {
        await axios.delete(`https://discord.com/api/v10/channels/${chId}/messages/${msgId}`, {
          headers: { 'Authorization': 'Bot ' + token }, timeout: 15000,
        });
      } catch (_) {}
    }
    res.json({
      ok: true,
      status: sendOk ? 'healthy' : 'identity_only',
      botName,
      message: sendOk ? `Bot ${botName} 正常（发消息+撤回均成功）` : `Bot 身份验证通过（${botName}），但发消息失败`,
    });
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.message || e.message;
    res.json({ ok: false, status: status === 401 ? 'invalid' : 'error', message: `请求失败: ${status || e.code} - ${msg}` });
  }
});

// 更新 Token（写入 .env 文件）
router.put('/api/admin/tokens/:server', requireRole('admin', 'super_admin'), (req, res) => {
  const { server } = req.params;
  const serverInfo = SERVERS.find(s => s.key === server);
  if (!serverInfo) return res.status(400).json({ error: '无效的服务器标识' });

  const { token } = req.body;
  if (!token || token.length < 20) return res.status(400).json({ error: 'Token 格式不正确' });

  try {
    let envContent = fs.readFileSync(ENV_PATH, 'utf-8');
    const key = serverInfo.envKey;
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key}=${token}`);
    } else {
      envContent += `\n${key}=${token}`;
    }
    fs.writeFileSync(ENV_PATH, envContent, 'utf-8');
    log.info(`管理员更新了 ${server} Bot Token`);
    res.json({ ok: true, message: `${serverInfo.label} Token 已更新，立即生效` });
  } catch (e) {
    res.status(500).json({ error: '写入 .env 失败: ' + e.message });
  }
});

// ===== DC 频道管理 API =====

// 获取所有频道
router.get('/api/admin/channels', requireRole('admin', 'super_admin'), (req, res) => {
  try {
    const channels = loadChannels();
    const list = Object.entries(channels).map(([name, info]) => ({
      name, bot: info.bot, channel_id: info.channel_id,
    }));
    res.json({ ok: true, data: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 新增频道
router.post('/api/admin/channels', requireRole('admin', 'super_admin'), (req, res) => {
  const { name, bot, channel_id } = req.body;
  if (!name || !bot || !channel_id) return res.status(400).json({ error: '频道名称、Bot 和频道ID 都必填' });
  if (!['TC', 'JP', 'SEA', 'KR'].includes(bot)) return res.status(400).json({ error: 'Bot 必须是 TC/JP/SEA/KR' });

  try {
    let data = { channels: {} };
    if (fs.existsSync(CHANNELS_JSON)) {
      data = JSON.parse(fs.readFileSync(CHANNELS_JSON, 'utf-8'));
    }
    if (data.channels[name]) return res.status(400).json({ error: '频道名称已存在' });
    data.channels[name] = { bot, channel_id };
    fs.writeFileSync(CHANNELS_JSON, JSON.stringify(data, null, 2), 'utf-8');
    log.info(`管理员新增频道: ${name} (${bot} - ${channel_id})`);
    res.json({ ok: true, message: '频道已添加' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 删除频道
router.delete('/api/admin/channels/:name', requireRole('admin', 'super_admin'), (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    if (!fs.existsSync(CHANNELS_JSON)) return res.status(404).json({ error: '频道文件不存在' });
    const data = JSON.parse(fs.readFileSync(CHANNELS_JSON, 'utf-8'));
    if (!data.channels[name]) return res.status(404).json({ error: '频道不存在' });
    delete data.channels[name];
    fs.writeFileSync(CHANNELS_JSON, JSON.stringify(data, null, 2), 'utf-8');
    log.info(`管理员删除频道: ${name}`);
    res.json({ ok: true, message: '频道已删除' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 用户洞察 API =====

// 生成周报式玩家洞察（上周五 ~ 本周四）
router.post('/api/admin/insights/analyze', requireRole('super_admin'), async (req, res) => {
  ensureInsightsTable();
  try {
    // 计算时间范围：最近的周五 00:00 ~ 下周四 23:59
    const now = new Date();
    const day = now.getDay(); // 0=Sun, 5=Fri
    const lastFriday = new Date(now);
    // 周五/周六 → 本周五；周日~周四 → 上周五
    if (day >= 5) {
      lastFriday.setDate(now.getDate() - (day - 5));
    } else {
      lastFriday.setDate(now.getDate() - (day + 2));
    }
    lastFriday.setHours(0, 0, 0, 0);

    const thisThursday = new Date(lastFriday);
    thisThursday.setDate(lastFriday.getDate() + 6);
    thisThursday.setHours(23, 59, 59, 999);

    const fmt = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    const startDate = fmt(lastFriday);
    const endDate = fmt(thisThursday);

    const periodLabel = `${startDate} ~ ${endDate}`;

    // 取全平台高质量反馈（多取一些）
    const twitterRecords = sentiment.getQualityFeedback(200, 'twitter', startDate, endDate + ' 23:59:59');
    const discordRecords = sentiment.getQualityFeedback(200, 'discord', startDate, endDate + ' 23:59:59');

    // 韩服 Naver Lounge 数据
    let loungeRecords = [];
    try {
      const rawLounge = db.queryAll(
        `SELECT * FROM lounge_posts WHERE crawled_at >= ? AND crawled_at <= ? ORDER BY crawled_at DESC LIMIT 200`,
        [startDate, endDate + ' 23:59:59']
      );
      loungeRecords = rawLounge.map(r => ({
        content: r.content || '',
        content_zh: r.content_zh || '',
        title_zh: r.title_zh || '',
        sentiment: r.sentiment || 'neutral',
        ai_category: r.ai_category || 'other',
        ai_summary: r.ai_summary || '',
        url: r.url || '',
        author: r.author || '匿名'
      }));
    } catch (e) {
      console.warn('⚠️ 韩服数据查询失败:', e.message);
    }

    const totalRecords = twitterRecords.length + discordRecords.length + loungeRecords.length;
    if (totalRecords < 3) {
      return res.json({ ok: false, message: `时间范围 ${periodLabel} 内数据不足（仅 ${totalRecords} 条），请先采集数据` });
    }

    // 格式化记录：保留原文 + 翻译
    const formatRecords = (records, platform) => {
      return records.map(r => {
        const original = r.content || '';
        const translated = r.translated_content || '';
        let line = `[${platform}] ${r.author || '匿名'}: ${original}`;
        if (translated && translated !== original) {
          line += `\n   [翻译] ${translated}`;
        }
        return line;
      }).join('\n');
    };

    const twitterText = formatRecords(twitterRecords, 'Twitter');
    const discordText = formatRecords(discordRecords, 'Discord');

    // 韩服格式化
    const loungeText = loungeRecords.map(r => {
      const original = r.content || r.title_zh || '';
      const translated = r.content_zh || r.title_zh || '';
      let line = `[Lounge] ${r.author}: ${original}`;
      if (translated && translated !== original) {
        line += `\n   [翻译] ${translated}`;
      }
      if (r.ai_summary) line += `\n   [AI摘要] ${r.ai_summary}`;
      return line;
    }).join('\n');

    const combinedText = 
      (discordText ? `=== Discord 繁中服 (${discordRecords.length}条) ===\n${discordText}\n\n` : '') +
      (twitterText ? `=== Twitter 日本 (${twitterRecords.length}条) ===\n${twitterText}\n\n` : '') +
      (loungeText ? `=== Naver Lounge 韩服 (${loungeRecords.length}条) ===\n${loungeText}` : '');

    // 固定格式 AI Prompt
    const prompt = `你是一位资深游戏运营分析师。请根据以下一周内（${periodLabel}）的玩家发言数据，严格按以下固定格式输出「玩家洞察周报」。

必须分为两个区域，每个区域独立分析：

---

## 🇹🇼 繁中服（Discord）

### ① 玩家意见/建议概述
（用 2-4 句话总结本周繁中服玩家的主要意见、吐槽和建议）

### ② 玩家原声
（挑选 1-2 条最有代表性的玩家原话，繁中原文直接引用，不需要翻译）
> 「玩家原话内容」—— 玩家昵称

### ③ 需求洞察
（从这些发言中洞察玩家真正想要什么：表面需求是什么？深层需求是什么？）

---

## 🇯🇵 日本（Twitter）

### ① 玩家意见/建议概述
（用 2-4 句话总结本周日服玩家的主要意见、吐槽和建议）

### ② 玩家原声
（挑选 1-2 条最有代表性的日语玩家原话，并翻译成中文）
> 「日语原文」—— 玩家昵称
> [中文翻译] 翻译内容

### ③ 需求洞察
（从这些发言中洞察玩家真正想要什么：表面需求是什么？深层需求是什么？）

---

## 🇰🇷 韩服（Naver Lounge）

### ① 玩家意见/建议概述
（用 2-4 句话总结本周韩服玩家的主要意见、吐槽和建议）

### ② 玩家原声
（挑选 1-2 条最有代表性的韩服玩家原话，并翻译成中文）
> 「韩语原文」—— 玩家昵称
> [中文翻译] 翻译内容

### ③ 需求洞察
（从这些发言中洞察玩家真正想要什么：表面需求是什么？深层需求是什么？）

---

重要规则：
- 严格按上述 ①②③ 格式输出，不要增加额外章节
- 如果某个区域数据不足，在该区域标注「本周数据不足，暂无分析」
- 日语内容必须翻译为中文
- 繁中内容保持原文，不翻译
- 全部用中文撰写概述和洞察部分`;

    // 调用 DeepSeek API
    let report = null;
    const deepseekKey = process.env.DEEPSEEK_API_KEY || '';
    if (deepseekKey) {
      try {
        const r = await axios.post('https://api.deepseek.com/v1/chat/completions', {
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: combinedText.substring(0, 8000) }
          ],
          temperature: 0.2,
          max_tokens: 2500,
        }, {
          headers: { 'Authorization': 'Bearer ' + deepseekKey, 'Content-Type': 'application/json' },
          timeout: 90000,
        });
        report = r.data?.choices?.[0]?.message?.content || null;
      } catch (aiErr) {
        console.error('AI 洞察分析失败:', aiErr.message);
      }
    }

    if (!report) {
      return res.json({ ok: false, message: 'AI 分析失败，请稍后重试' });
    }

    // 存档到数据库（同周期覆盖更新）
    try {
      // 确保 lounge_count 列存在
      try { db.getDb().run('ALTER TABLE insights_reports ADD COLUMN lounge_count INTEGER DEFAULT 0'); } catch(_) {}
      const existing = db.queryOne('SELECT id FROM insights_reports WHERE period = ?', [periodLabel]);
      if (existing) {
        db.getDb().run(
          'UPDATE insights_reports SET content=?, twitter_count=?, discord_count=?, lounge_count=?, total_records=?, created_at=datetime(\'now\',\'+8 hours\') WHERE id=?',
          [report, twitterRecords.length, discordRecords.length, loungeRecords.length, totalRecords, existing.id]
        );
      } else {
        db.getDb().run(
          'INSERT INTO insights_reports (period, content, twitter_count, discord_count, lounge_count, total_records) VALUES (?, ?, ?, ?, ?, ?)',
          [periodLabel, report, twitterRecords.length, discordRecords.length, loungeRecords.length, totalRecords]
        );
      }
      db.saveDb();
    } catch (saveErr) {
      console.error('⚠️ 洞察报告存档失败:', saveErr.message);
    }

    res.json({
      ok: true,
      period: periodLabel,
      totalRecords,
      twitterCount: twitterRecords.length,
      discordCount: discordRecords.length,
      loungeCount: loungeRecords.length,
      report,
    });
  } catch (e) {
    console.error('用户洞察分析失败:', e.message);
    res.status(500).json({ error: '分析失败: ' + e.message });
  }
});

// 获取历史洞察报告列表
router.get('/api/admin/insights/list', requireRole('super_admin'), (req, res) => {
  ensureInsightsTable();
  try {
    const reports = db.queryAll('SELECT id, period, twitter_count, discord_count, COALESCE(lounge_count, 0) as lounge_count, total_records, created_at FROM insights_reports ORDER BY created_at DESC');
    res.json({ ok: true, data: reports });
  } catch (e) {
    res.status(500).json({ error: '获取列表失败: ' + e.message });
  }
});

// 获取单篇洞察报告详情
router.get('/api/admin/insights/:id', requireRole('super_admin'), (req, res) => {
  ensureInsightsTable();
  try {
    const report = db.queryOne('SELECT * FROM insights_reports WHERE id = ?', [req.params.id]);
    if (!report) return res.status(404).json({ error: '报告不存在' });
    res.json({ ok: true, data: report });
  } catch (e) {
    res.status(500).json({ error: '获取失败: ' + e.message });
  }
});

// ===== 数据库管理 API =====

// 白名单：只允许管理这些表
const DB_MANAGEABLE_TABLES = [
  'sentiment_records', 'lounge_posts', 'lounge_comments',
  'lounge_daily_reports', 'topic_history', 'daily_snapshots',
  'feedbacks', 'insights_reports', 'weekly_reports',
];

// 每张表的主键列和时间列
const TABLE_META = {
  sentiment_records: { pk: 'id', timeCol: 'created_at', label: '舆情记录' },
  lounge_posts:       { pk: 'id', timeCol: 'crawled_at', label: '韩国帖子' },
  lounge_comments:    { pk: 'id', timeCol: 'crawled_at', label: '韩国评论' },
  lounge_daily_reports:{ pk: 'id', timeCol: 'created_at', label: '韩国日报' },
  topic_history:      { pk: 'id', timeCol: 'created_at', label: '话题历史' },
  daily_snapshots:    { pk: 'id', timeCol: 'created_at', label: '每日快照' },
  feedbacks:          { pk: 'id', timeCol: 'created_at', label: '用户反馈' },
  insights_reports:   { pk: 'id', timeCol: 'created_at', label: '洞察报告' },
  weekly_reports:     { pk: 'id', timeCol: 'created_at', label: '周报' },
};

function isValidTable(name) {
  return DB_MANAGEABLE_TABLES.includes(name);
}

// GET /api/admin/db/stats — 数据库整体统计
router.get('/api/admin/db/stats', requireRole('admin', 'super_admin'), (req, res) => {
  try {
    const { DB_PATH } = require('../config');
    const fs = require('fs');
    let fileSize = 0;
    try { fileSize = fs.statSync(DB_PATH).size; } catch (_) {}
    
    // 查所有表名
    const tables = db.queryAll("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    let totalRows = 0;
    const tableStats = [];
    for (const t of tables) {
      try {
        const row = db.queryOne(`SELECT COUNT(*) as cnt FROM "${t.name}"`);
        const cnt = row?.cnt || 0;
        totalRows += cnt;
        tableStats.push({ name: t.name, rows: cnt });
      } catch (_) {}
    }
    
    res.json({
      ok: true,
      data: {
        fileSize,
        fileSizeHuman: fileSize > 1048576 ? (fileSize / 1048576).toFixed(1) + ' MB' : (fileSize / 1024).toFixed(1) + ' KB',
        totalTables: tables.length,
        totalRows,
        tables: tableStats,
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/db/tables — 列出可管理表 + 行数 + 最新记录时间
router.get('/api/admin/db/tables', requireRole('admin', 'super_admin'), (req, res) => {
  try {
    const result = [];
    for (const tableName of DB_MANAGEABLE_TABLES) {
      const meta = TABLE_META[tableName] || {};
      let rowCount = 0, latestAt = null;
      try {
        const cntRow = db.queryOne(`SELECT COUNT(*) as cnt FROM "${tableName}"`);
        rowCount = cntRow?.cnt || 0;
      } catch (_) {}
      if (meta.timeCol) {
        try {
          const latest = db.queryOne(`SELECT MAX("${meta.timeCol}") as latest FROM "${tableName}"`);
          latestAt = latest?.latest || null;
        } catch (_) {}
      }
      result.push({
        name: tableName,
        label: meta.label || tableName,
        rows: rowCount,
        latestAt,
        pk: meta.pk || 'id',
        timeCol: meta.timeCol || null,
      });
    }
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/db/tables/:name — 分页查询表数据
router.get('/api/admin/db/tables/:name', requireRole('admin', 'super_admin'), (req, res) => {
  const { name } = req.params;
  if (!isValidTable(name)) return res.status(400).json({ error: '不可管理的表' });
  
  const page = parseInt(req.query.page) || 1;
  const size = Math.min(parseInt(req.query.size) || 50, 200);
  const search = req.query.search || '';
  const offset = (page - 1) * size;
  
  try {
    let where = '';
    const params = [];
    if (search) {
      // 搜索所有 TEXT 类型列
      const cols = db.queryAll(`PRAGMA table_info("${name}")`);
      const textCols = cols.filter(c => c.type && c.type.toUpperCase().includes('TEXT')).map(c => c.name);
      if (textCols.length > 0) {
        const conds = textCols.map(c => `"${c}" LIKE ?`);
        where = 'WHERE ' + conds.join(' OR ');
        const s = `%${search}%`;
        for (let i = 0; i < textCols.length; i++) params.push(s);
      }
    }
    
    const total = db.queryOne(`SELECT COUNT(*) as cnt FROM "${name}" ${where}`, params);
    const rows = db.queryAll(
      `SELECT * FROM "${name}" ${where} ORDER BY "${TABLE_META[name]?.pk || 'id'}" DESC LIMIT ? OFFSET ?`,
      [...params, size, offset]
    );
    
    // 获取列信息
    const columns = db.queryAll(`PRAGMA table_info("${name}")`).map(c => ({
      name: c.name, type: c.type, pk: !!c.pk
    }));
    
    res.json({
      ok: true,
      data: {
        rows,
        columns,
        pagination: {
          page, size,
          total: total?.cnt || 0,
          totalPages: Math.ceil((total?.cnt || 0) / size),
        }
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/db/tables/:name/:id — 单条记录详情
router.get('/api/admin/db/tables/:name/:id', requireRole('admin', 'super_admin'), (req, res) => {
  const { name, id } = req.params;
  if (!isValidTable(name)) return res.status(400).json({ error: '不可管理的表' });
  const pk = TABLE_META[name]?.pk || 'id';
  try {
    const row = db.queryOne(`SELECT * FROM "${name}" WHERE "${pk}" = ?`, [id]);
    if (!row) return res.status(404).json({ error: '记录不存在' });
    res.json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/db/tables/:name/:id — 编辑单条记录
router.put('/api/admin/db/tables/:name/:id', requireRole('admin', 'super_admin'), (req, res) => {
  const { name, id } = req.params;
  if (!isValidTable(name)) return res.status(400).json({ error: '不可管理的表' });
  const pk = TABLE_META[name]?.pk || 'id';
  const fields = req.body;
  if (!fields || Object.keys(fields).length === 0) return res.status(400).json({ error: '无更新内容' });
  
  try {
    // 排除主键
    delete fields[pk];
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`"${k}" = ?`);
      vals.push(v);
    }
    vals.push(id);
    db.getDb().run(`UPDATE "${name}" SET ${sets.join(', ')} WHERE "${pk}" = ?`, vals);
    db.saveDb();
    log.info(`[DB管理] ${req.user.username} 编辑了 ${name} #${id}`);
    res.json({ ok: true, message: '更新成功' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/db/tables/:name/:id — 删除单条记录
router.delete('/api/admin/db/tables/:name/:id', requireRole('admin', 'super_admin'), (req, res) => {
  const { name, id } = req.params;
  if (!isValidTable(name)) return res.status(400).json({ error: '不可管理的表' });
  const pk = TABLE_META[name]?.pk || 'id';
  try {
    db.getDb().run(`DELETE FROM "${name}" WHERE "${pk}" = ?`, [id]);
    db.saveDb();
    log.info(`[DB管理] ${req.user.username} 删除了 ${name} #${id}`);
    res.json({ ok: true, message: '删除成功' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/db/tables/:name/batch-delete — 批量删除
router.post('/api/admin/db/tables/:name/batch-delete', requireRole('admin', 'super_admin'), (req, res) => {
  const { name } = req.params;
  if (!isValidTable(name)) return res.status(400).json({ error: '不可管理的表' });
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '请选择要删除的记录' });
  if (ids.length > 500) return res.status(400).json({ error: '单次最多删除500条' });
  
  const pk = TABLE_META[name]?.pk || 'id';
  try {
    const placeholders = ids.map(() => '?').join(',');
    db.getDb().run(`DELETE FROM "${name}" WHERE "${pk}" IN (${placeholders})`, ids);
    db.saveDb();
    log.info(`[DB管理] ${req.user.username} 批量删除了 ${name} ${ids.length} 条`);
    res.json({ ok: true, message: `已删除 ${ids.length} 条` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/db/recrawl/:postId — 重新爬取指定韩国帖子
router.post('/api/admin/db/recrawl/:postId', requireRole('admin', 'super_admin'), async (req, res) => {
  const { postId } = req.params;
  try {
    let loungeCrawler;
    try { loungeCrawler = require('../lounge_crawler'); } catch (_) { return res.status(500).json({ error: '爬虫模块未加载' }); }
    
    // 查帖子信息
    const post = db.queryOne('SELECT * FROM lounge_posts WHERE post_id = ?', [postId]);
    if (!post) return res.status(404).json({ error: '帖子不存在' });
    
    res.json({ ok: true, message: '重爬任务已启动，请稍后刷新查看' });
    
    // 异步执行重爬
    (async () => {
      try {
        const result = await loungeCrawler.recrawlPost(postId);
        if (result.success) {
          // 重爬成功后重新翻译
          try {
            const loungeRoute = require('./lounge');
            await loungeRoute.translateAndAnalyze(5);
          } catch (_) {}
          console.log(`  [DB管理] 重爬帖子 ${postId} 完成`);
        } else {
          console.error(`  [DB管理] 重爬帖子 ${postId} 失败:`, result.message);
        }
      } catch (e) {
        console.error(`  [DB管理] 重爬帖子 ${postId} 异常:`, e.message);
      }
    })();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 删除洞察报告
router.delete('/api/admin/insights/:id', requireRole('super_admin'), (req, res) => {
  ensureInsightsTable();
  try {
    db.getDb().run('DELETE FROM insights_reports WHERE id = ?', [req.params.id]);
    db.saveDb();
    res.json({ ok: true, message: '报告已删除' });
  } catch (e) {
    res.status(500).json({ error: '删除失败: ' + e.message });
  }
});

module.exports = router;
