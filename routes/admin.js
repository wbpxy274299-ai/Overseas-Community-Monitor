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
const { getDiscordToken, getProxyConfig, ENV_PATH, loadChannels } = require('../config');
const sentiment = require('../sentiment');
const aiAnalyzer = require('../ai_analyzer');

// Discord 服务器列表
const SERVERS = [
  { key: 'TC',  label: '繁中服', envKey: 'DISCORD_TC_BOT_TOKEN' },
  { key: 'JP',  label: '日服',   envKey: 'DISCORD_JP_BOT_TOKEN' },
  { key: 'SEA', label: '东南亚服', envKey: 'DISCORD_SEA_BOT_TOKEN' },
  { key: 'KR',  label: '韩服',   envKey: 'DISCORD_KR_BOT_TOKEN' },
];

// 频道 JSON 文件路径
const CHANNELS_JSON = path.join(__dirname, '..', 'dc-publish-channels.json');

router.use(requireAuth);

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

  const proxy = getProxyConfig();
  try {
    // 1. 验证 Bot 身份
    const me = await axios.get('https://discord.com/api/v10/users/@me', {
      headers: { 'Authorization': 'Bot ' + token },
      timeout: 30000,
      proxy,
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
        { content: `[Health Check] ${new Date().toISOString()}` },
        { headers: { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' }, timeout: 30000, proxy }
      );
      sendOk = true;
      msgId = sendRes.data?.id;
    } catch (_) {}
    // 撤回
    if (msgId) {
      try {
        await axios.delete(`https://discord.com/api/v10/channels/${chId}/messages/${msgId}`, {
          headers: { 'Authorization': 'Bot ' + token }, timeout: 15000, proxy,
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
    // 计算时间范围：上周五 00:00 ~ 本周四 23:59
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 4=Thu, 5=Fri
    // 本周五
    const thisFriday = new Date(now);
    const diffToFri = (5 - dayOfWeek + 7) % 7;
    thisFriday.setDate(now.getDate() - (diffToFri === 0 && dayOfWeek === 5 ? 0 : diffToFri === 0 ? 7 : (dayOfWeek > 5 ? dayOfWeek - 5 : dayOfWeek + 2)));
    // 简化：直接找上周五
    const lastFriday = new Date(now);
    const daysBack = (dayOfWeek - 5 + 7) % 7 + (dayOfWeek < 5 ? 7 : 0);
    lastFriday.setDate(now.getDate() - daysBack);
    if (dayOfWeek === 5) lastFriday.setDate(now.getDate()); // 如果今天就是周五
    lastFriday.setHours(0, 0, 0, 0);

    const thisThursday = new Date(lastFriday);
    thisThursday.setDate(lastFriday.getDate() + 6);
    thisThursday.setHours(23, 59, 59, 999);

    const startDate = lastFriday.getFullYear() + '-' + String(lastFriday.getMonth()+1).padStart(2,'0') + '-' + String(lastFriday.getDate()).padStart(2,'0');
    const endDate = thisThursday.getFullYear() + '-' + String(thisThursday.getMonth()+1).padStart(2,'0') + '-' + String(thisThursday.getDate()).padStart(2,'0');

    const periodLabel = `${startDate} ~ ${endDate}`;

    // 取全平台高质量反馈（多取一些）
    const twitterRecords = sentiment.getQualityFeedback(200, 'twitter', startDate, endDate + ' 23:59:59');
    const discordRecords = sentiment.getQualityFeedback(200, 'discord', startDate, endDate + ' 23:59:59');

    const totalRecords = twitterRecords.length + discordRecords.length;
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
    const combinedText = (discordText ? `=== Discord 繁中服 (${discordRecords.length}条) ===\n${discordText}\n\n` : '') +
                          (twitterText ? `=== Twitter 日本 (${twitterRecords.length}条) ===\n${twitterText}` : '');

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
          proxy: getProxyConfig(),
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
      const existing = db.queryOne('SELECT id FROM insights_reports WHERE period = ?', [periodLabel]);
      if (existing) {
        db.getDb().run(
          'UPDATE insights_reports SET content=?, twitter_count=?, discord_count=?, total_records=?, created_at=datetime(\'now\',\'+8 hours\') WHERE id=?',
          [report, twitterRecords.length, discordRecords.length, totalRecords, existing.id]
        );
      } else {
        db.getDb().run(
          'INSERT INTO insights_reports (period, content, twitter_count, discord_count, total_records) VALUES (?, ?, ?, ?, ?)',
          [periodLabel, report, twitterRecords.length, discordRecords.length, totalRecords]
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
    const reports = db.queryAll('SELECT id, period, twitter_count, discord_count, total_records, created_at FROM insights_reports ORDER BY created_at DESC');
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
