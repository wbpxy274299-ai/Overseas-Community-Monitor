/**
 * M2G 用户运营后台 - 舆情监控模块
 * 负责采集、分析和展示各平台的玩家反馈
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getDiscordToken, fmtCST8 } = require('./config');
const DISCORD_API_BASE = 'https://discord.com/api/v10';
const db = require('./db');
const log = require('./logger');
const translator = require('./translator');
const aiAnalyzer = require('./ai_analyzer');
const { fetchMessages, fetchMessagesAfter, nowCst, formatCst } = require('./scanner');

// ===== 全局采集锁（防止并发冲突）=====
let isCollecting = false;

// 采集锁操作封装
function getIsCollecting() { return isCollecting; }
function setIsCollecting(val) { isCollecting = val; }

// ===== 全局错误日志 + 采集状态记录 =====
// 打个比方：这就是系统的「黑匣子」，出了问题可以看它
const systemErrors = [];  // 最多保留50条错误
const collectionStatus = {
  twitter: { lastRun: null, lastCount: 0, lastError: null },
  discord: { lastRun: null, lastCount: 0, lastError: null },
  analysis: { lastRun: null, topicCount: 0, lastError: null },
};

function recordError(source, message) {
  const entry = { time: fmtCST8(new Date()), source, message: String(message).substring(0, 200) };
  systemErrors.unshift(entry);
  if (systemErrors.length > 50) systemErrors.length = 50;
  console.error(`❌ [${source}] ${message}`);
}

function getSystemErrors() { return systemErrors; }
function getCollectionStatus() { return collectionStatus; }

// ★ 日期格式化统一使用 config.js 的 fmtCST8（不再重复定义）

// ===== 时间格式统一规范化 =====
// 比喻：就像所有入库的货物都要统一贴标准标签，不管原来贴的是什么格式
function normalizeDateTime(timeValue) {
  if (!timeValue) return formatCst(nowCst());
  const str = String(timeValue).trim();
  
  // 已经是标准格式 YYYY-MM-DD HH:MM:SS
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) return str;
  
  // 带时区偏移：2026-07-27 12:14:58 +08:00
  const tzMatch = str.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*[+\-]\d{2}:\d{2}$/);
  if (tzMatch) return tzMatch[1];
  
  // 中文格式：2026年07月27日 10:49:57
  const cnMatch = str.match(/^(\d{4})\D(\d{1,2})\D(\d{1,2})\D?\s*(\d{1,2}):(\d{2}):(\d{2})/);
  if (cnMatch) {
    return `${cnMatch[1]}-${cnMatch[2].padStart(2,'0')}-${cnMatch[3].padStart(2,'0')} ${cnMatch[4].padStart(2,'0')}:${cnMatch[5]}:${cnMatch[6]}`;
  }
  
  // 斜杠格式：2026/07/27 12:14:58
  const slashMatch = str.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (slashMatch) {
    return `${slashMatch[1]}-${slashMatch[2].padStart(2,'0')}-${slashMatch[3].padStart(2,'0')} ${slashMatch[4].padStart(2,'0')}:${slashMatch[5]}:${slashMatch[6]}`;
  }
  
  // 其他格式：尝试 new Date 解析
  try {
    const d = new Date(str);
    if (!isNaN(d.getTime())) return formatCst(d);
  } catch (_) {}
  
  return formatCst(nowCst());
}

// ===== 数据库表结构 =====
async function initSentimentTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS sentiment_records (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      platform        TEXT NOT NULL,           -- 平台: discord/facebook/twitter/game/internal
      source_id       TEXT,                    -- 原始ID（如 Discord message_id）
      content         TEXT NOT NULL,           -- 反馈内容
      translated_content TEXT,                 -- 翻译后的内容（日语->中文）
      author          TEXT,                    -- 作者/用户
      channel_name    TEXT,                    -- 来源频道/群组
      region          TEXT DEFAULT 'tc',       -- 服务器区域: tc/jp/sea/kr (新增)
      sentiment       TEXT DEFAULT 'neutral',  -- 情感: positive/neutral/negative（规则）
      ai_sentiment    TEXT,                    -- AI 情感分析结果
      ai_confidence   REAL,                    -- AI 置信度 (0-1)
      ai_reason       TEXT,                    -- AI 判断理由
      ai_category     TEXT,                    -- AI 分类: bug/suggestion/complaint/praise/question/other
      keywords        TEXT,                    -- 关键词（逗号分隔）
      category        TEXT,                    -- 分类（规则）: bug/feature/pricing/event/complaint/suggestion
      priority        INTEGER DEFAULT 0,       -- 优先级: 0-5
      created_at      TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
      processed       INTEGER DEFAULT 0,       -- 是否已处理
      handler         TEXT,                    -- 处理人
      time_text       TEXT,                    -- Yahoo页面显示的时间文本（如 "5分前"、"昨日 21:47"）
      url             TEXT,                    -- Twitter原帖链接（清理后）
      has_media       INTEGER DEFAULT 0        -- 是否带图/视频: 0=否, 1=是
    )
  `;
  
  try {
    db.getDb().run(sql);
    
    // 兼容：旧表可能没有新字段
    try { db.getDb().run('ALTER TABLE sentiment_records ADD COLUMN time_text TEXT'); } catch (_) {}
    try { db.getDb().run('ALTER TABLE sentiment_records ADD COLUMN url TEXT'); } catch (_) {}
    try { db.getDb().run('ALTER TABLE sentiment_records ADD COLUMN has_media INTEGER DEFAULT 0'); } catch (_) {}
    
    db.saveDb();
    
    // 添加索引
    db.getDb().run('CREATE INDEX IF NOT EXISTS idx_sentiment_platform ON sentiment_records(platform)');
    db.getDb().run('CREATE INDEX IF NOT EXISTS idx_sentiment_created ON sentiment_records(created_at DESC)');
    db.getDb().run('CREATE INDEX IF NOT EXISTS idx_sentiment_sentiment ON sentiment_records(sentiment)');
    db.getDb().run('CREATE INDEX IF NOT EXISTS idx_sentiment_category ON sentiment_records(category)');
    db.getDb().run('CREATE INDEX IF NOT EXISTS idx_sentiment_ai_sentiment ON sentiment_records(ai_sentiment)');
    
    // 新增复合索引（提升查询性能）
    db.getDb().run('CREATE INDEX IF NOT EXISTS idx_sentiment_platform_created ON sentiment_records(platform, created_at DESC)');
    db.getDb().run('CREATE INDEX IF NOT EXISTS idx_sentiment_region_created ON sentiment_records(region, created_at DESC)');
    db.saveDb();
    
    // 兼容：旧表可能没有 AI 相关列
    try { db.getDb().run('ALTER TABLE sentiment_records ADD COLUMN translated_content TEXT'); } catch (_) {}
    try { db.getDb().run('ALTER TABLE sentiment_records ADD COLUMN ai_sentiment TEXT'); } catch (_) {}
    try { db.getDb().run('ALTER TABLE sentiment_records ADD COLUMN ai_confidence REAL'); } catch (_) {}
    try { db.getDb().run('ALTER TABLE sentiment_records ADD COLUMN ai_reason TEXT'); } catch (_) {}
    try { db.getDb().run('ALTER TABLE sentiment_records ADD COLUMN ai_category TEXT'); } catch (_) {}
    // 新增：噪音过滤 + 质量评分 + 话题标签
    try { db.getDb().run('ALTER TABLE sentiment_records ADD COLUMN is_noise INTEGER DEFAULT 0'); } catch (_) {}
    try { db.getDb().run('ALTER TABLE sentiment_records ADD COLUMN content_quality INTEGER DEFAULT 0'); } catch (_) {}
    try { db.getDb().run('ALTER TABLE sentiment_records ADD COLUMN topic_tag TEXT DEFAULT \'general\''); } catch (_) {}
    // 新增：服务器区域字段
    try { db.getDb().run('ALTER TABLE sentiment_records ADD COLUMN region TEXT DEFAULT \'tc\''); } catch (_) {}
    db.saveDb();
    
    // 新增索引：用于高质量数据查询
    db.getDb().run('CREATE INDEX IF NOT EXISTS idx_sentiment_quality ON sentiment_records(content_quality)');
    db.getDb().run('CREATE INDEX IF NOT EXISTS idx_sentiment_noise ON sentiment_records(is_noise)');
    db.getDb().run('CREATE INDEX IF NOT EXISTS idx_sentiment_topic ON sentiment_records(topic_tag)');
    // 新增：区域索引（用于繁中/日服区分）
    db.getDb().run('CREATE INDEX IF NOT EXISTS idx_sentiment_region ON sentiment_records(region)');
    db.saveDb();
    
    // 启动时自动修正 Twitter 旧数据的 region（应为 'jp'，之前默认值是 'tc'）
    try {
      const twWrong = db.queryOne("SELECT COUNT(*) as cnt FROM sentiment_records WHERE platform='twitter' AND region != 'jp'");
      if (twWrong && twWrong.cnt > 0) {
        db.getDb().run("UPDATE sentiment_records SET region = 'jp' WHERE platform = 'twitter'");
        db.saveDb();
        console.log(`✅ Twitter region 自动修正: ${twWrong.cnt} 条 tc→jp`);
      }
    } catch (e) {
      console.warn('⚠️ Twitter region 修正失败:', e.message);
    }
    
    // 启动时自动修正非标准时间格式（如“2026年07月27日 10:49:57” → “2026-07-27 10:49:57”）
    try {
      const badDates = db.queryAll(
        "SELECT id, created_at FROM sentiment_records WHERE created_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]' LIMIT 500"
      );
      if (badDates.length > 0) {
        let fixed = 0;
        for (const row of badDates) {
          const normalized = normalizeDateTime(row.created_at);
          if (normalized !== row.created_at) {
            db.getDb().run('UPDATE sentiment_records SET created_at = ? WHERE id = ?', [normalized, row.id]);
            fixed++;
          }
        }
        if (fixed > 0) {
          db.saveDb();
          console.log(`✅ 时间格式自动修正: ${fixed} 条非标准格式已统一为 YYYY-MM-DD HH:MM:SS`);
        }
      }
    } catch (e) {
      console.warn('⚠️ 时间格式修正失败:', e.message);
    }
    
    console.log('✅ 舆情监控数据库表初始化完成');
  } catch (e) {
    console.error('❌ 初始化舆情监控表失败:', e.message);
  }
}

// ===== 周报数据库表结构 =====
async function initWeeklyReportsTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS weekly_reports (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,           -- 报告标题
      content         TEXT NOT NULL,           -- Markdown 内容
      risk_level      TEXT DEFAULT 'low',      -- 风险等级: low/medium/high
      twitter_count   INTEGER DEFAULT 0,       -- Twitter 数据条数
      discord_count   INTEGER DEFAULT 0,       -- Discord 数据条数
      summary         TEXT,                    -- 摘要（一句话总结）
      created_at      TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
    )
  `;
  
  try {
    db.getDb().run(sql);
    db.saveDb();
    
    // 添加索引
    db.getDb().run('CREATE INDEX IF NOT EXISTS idx_reports_created ON weekly_reports(created_at DESC)');
    db.getDb().run('CREATE INDEX IF NOT EXISTS idx_reports_risk ON weekly_reports(risk_level)');
    db.saveDb();
    
    console.log('✅ 周报数据库表初始化完成');
  } catch (e) {
    console.error('❌ 初始化周报表失败:', e.message);
  }
}

// ===== 话题历史数据库表结构（用于趋势分析 + AI分析存档）=====
async function initTopicHistoryTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS topic_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_title     TEXT NOT NULL,           -- 话题标题
      platform        TEXT NOT NULL,           -- 平台: twitter/discord
      sentiment       TEXT DEFAULT 'neutral',  -- 情绪: positive/neutral/negative
      heat_score      REAL DEFAULT 5.0,        -- 热度评分 (1-10)
      record_count    INTEGER DEFAULT 0,       -- 相关记录数
      topic_tag       TEXT DEFAULT 'general',  -- 话题标签
      action_suggestion TEXT,                  -- 运营建议
      is_new_topic    INTEGER DEFAULT 0,       -- 是否新话题
      heat_change     REAL DEFAULT 0.0,        -- 热度变化
      trend           TEXT DEFAULT 'stable',   -- 趋势: rising/stable/falling
      summary         TEXT,                    -- AI摘要
      detail          TEXT,                    -- AI深度分析
      representative_quotes TEXT,              -- 玩家原声(JSON)
      urls            TEXT,                    -- 原帖链接(JSON)
      created_at      TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
    )
  `;
  
  try {
    db.getDb().run(sql);
    db.saveDb();
    
    // 添加索引
    db.getDb().run('CREATE INDEX IF NOT EXISTS idx_topic_history_time ON topic_history(created_at DESC)');
    db.getDb().run('CREATE INDEX IF NOT EXISTS idx_topic_history_platform ON topic_history(platform)');
    db.getDb().run('CREATE INDEX IF NOT EXISTS idx_topic_history_title ON topic_history(topic_title)');
    
    // 安全添加新列（已存在则忽略）
    try { db.getDb().run('ALTER TABLE topic_history ADD COLUMN summary TEXT'); } catch (_) {}
    try { db.getDb().run('ALTER TABLE topic_history ADD COLUMN detail TEXT'); } catch (_) {}
    try { db.getDb().run('ALTER TABLE topic_history ADD COLUMN representative_quotes TEXT'); } catch (_) {}
    try { db.getDb().run('ALTER TABLE topic_history ADD COLUMN urls TEXT'); } catch (_) {}
    
    db.saveDb();
    console.log('✅ 话题历史表初始化完成');
  } catch (e) {
    console.error('❌ 初始化话题历史表失败:', e.message);
  }
}

// ===== 工具函数：获取今日统计周期（昨日 8:30 ~ 今日 8:30）=====
function getTodayPeriod() {
  // 服务器已设 TZ=Asia/Shanghai，直接用本地时间
  const now = new Date();
  const h = now.getHours(), m = now.getMinutes();
  
  // 今日 8:30
  const today830 = new Date(now);
  today830.setHours(8, 30, 0, 0);
  
  // 核心逻辑：窗口永远是"前一日 8:30 ~ 当日 8:30"
  // 不管当前几点，都往前推 24 小时
  const end = today830;  // 今日 8:30
  const start = new Date(end.getTime() - 86400000);  // 前日 8:30
  
  const fmt = (d) => fmtCST8(d);
  return {
    startDate: fmt(start),
    endDate: fmt(end),
    periodLabel: `${fmt(start).substring(0,10)} 8:30 ~ ${fmt(end).substring(0,10)} 8:30`
  };
}

// ===== 情感分析（支持中日文）=====
function analyzeSentiment(text) {
  if (!text) return { sentiment: 'neutral', score: 0 };
  
  const lowerText = text.toLowerCase();
  
  // 正面词汇（中文 + 日文）
  const positiveWords = [
    // 中文简体
    '喜欢', '好评', '不错', '很好', '优秀', '完美', '满意', '开心',
    '好玩', '有趣', '期待', '支持', '推荐', '棒', '赞',
    // 中文繁体
    '喜歡', '好評', '不錯', '很好', '優秀', '完美', '滿意', '開心',
    '好玩', '有趣', '期待', '支持', '推薦', '棒', '讚',
    // 日文
    '好き', 'いい', '素晴らしい', '楽しい', '面白い', '期待', 'おすすめ',
    '最高', '素敵', '可愛い', 'かっこいい', 'ありがとう', '感謝',
    // 英文
    'good', 'great', 'excellent', 'amazing', 'love', 'like', 'awesome',
    'perfect', 'wonderful', 'fantastic', 'nice', 'happy', 'enjoy'
  ];
  
  // 负面词汇（中文 + 日文）
  const negativeWords = [
    // 中文简体
    '垃圾', '差评', '糟糕', '恶心', 'BUG', '错误', '崩溃', '卡顿', '慢',
    '失望', '不满', '生气', '愤怒', '投诉', '退坑', '退游',
    // 中文繁体
    '垃圾', '差評', '糟糕', '噁心', '錯誤', '崩潰', '卡頓', '慢',
    '失望', '不滿', '生氣', '憤怒', '投訴', '退坑', '退遊',
    // 日文
    'ダメ', '悪い', 'ひどい', 'つまらない', '嫌', '怒', '悲',
    'バグ', 'エラー', 'クラッシュ', '遅い', 'がっかり', '不満',
    '辞める', '退屈', 'うざい', '最悪',
    // 英文
    'bad', 'terrible', 'awful', 'hate', 'dislike', 'worst', 'horrible',
    'bug', 'error', 'broken', 'fail', 'crash', 'lag', 'slow'
  ];
  
  let positiveCount = 0;
  let negativeCount = 0;
  
  for (const word of positiveWords) {
    if (lowerText.includes(word)) positiveCount++;
  }
  
  for (const word of negativeWords) {
    if (lowerText.includes(word)) negativeCount++;
  }
  
  // 计算情感分数 (-1 到 1)
  const total = positiveCount + negativeCount;
  if (total === 0) return { sentiment: 'neutral', score: 0 };
  
  const score = (positiveCount - negativeCount) / total;
  
  let sentiment;
  if (score > 0.3) sentiment = 'positive';
  else if (score < -0.3) sentiment = 'negative';
  else sentiment = 'neutral';
  
  return { sentiment, score: score.toFixed(2) };
}

// ===== 关键词提取 =====
function extractKeywords(text) {
  if (!text || text.length < 10) return [];
  
  // 预定义的游戏相关关键词（含游戏专有名词）
  const gameKeywords = [
    // 游戏系统/玩法
    '树缘', '拍照', '骑士团', '狂潮', '公会', '副本', '世界boss', '世界王',
    '竞技场', 'PVP', 'PVE', '公会战', '骑士团战', '组队', '转职', '觉醒',
    // 角色/装备
    '时装', '皮肤', '新角色', '武器', '装备', '强化', '宝石', '卡片',
    // 活动/福利
    '活动', '奖励', '福利', '赠送', '限时', '庆典', '签到', '充值', '氪金',
    // 技术问题
    'BUG', 'bug', '错误', '崩溃', '卡顿', '延迟', '登录', '服务器',
    // 社交/体验
    '聊天', '好友', '画质', '音效', '操作', '难度', '平衡',
    // 日语关键词（不含搜索词“ツリネバ”）
    '騎士団', '狂潮', 'ガチャ', 'イベント', 'スキン',
    'キャラクター', 'クエスト', 'バトル', 'ログイン'
  ];
  
  const found = [];
  for (const keyword of gameKeywords) {
    if (text.toLowerCase().includes(keyword.toLowerCase())) {
      found.push(keyword);
    }
  }
  
  return found.slice(0, 5); // 最多返回5个关键词
}

// ===== 分类识别 =====
function classifyContent(text) {
  if (!text) return 'other';
  
  const lowerText = text.toLowerCase();
  
  // BUG 报告
  if (/bug|错误|崩溃|无法|不能|失败|報错|exception/i.test(lowerText)) {
    return 'bug';
  }
  
  // 功能建议
  if (/希望|建议|想要|增加|添加|改进|优化/i.test(lowerText)) {
    return 'suggestion';
  }
  
  // 价格/充值相关
  if (/价格|太贵|便宜|充值|金|付费|花钱|性价比/i.test(lowerText)) {
    return 'pricing';
  }
  
  // 活动相关
  if (/活动|奖励|福利|赠送|限时|庆典/i.test(lowerText)) {
    return 'event';
  }
  
  // 投诉
  if (/投诉|不满|失望|生气|愤怒|举报/i.test(lowerText)) {
    return 'complaint';
  }
  
  // 新功能请求
  if (/新功能|新模式|新玩法|期待/i.test(lowerText)) {
    return 'feature';
  }
  
  return 'other';
}

// ===== 噪音过滤：判断消息是否有分析价值 =====
function isMessageValuable(text, platform) {
  if (!text) return false;
  
  // 1. 清理：移除 @mention、URL、emoji
  let clean = text
    .replace(/<@!?\d+>/g, '')       // Discord @mention
    .replace(/https?:\/\/\S+/g, '')  // URL
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{FE0F}]/gu, '')
    .replace(/[:：!！?.。\s]+/g, '')  // 标点和空格
    .trim();
  
  // 2. 长度门槛
  const minLen = platform === 'twitter' ? 8 : 5;
  if (clean.length < minLen) return false;
  
  // 3. 问候语/水词黑名单（精确匹配）
  const greetings = [
    '早安', '晚安', '午安', '早安啊', '晚安あ',
    '有人嗎', '有人吗', '大家好', '大家好あ',
    '吃瓜', '瓜呢', '吃瓜吃瓜',
    '哈哈哈', '呵呵', '嗯嗯', '好的', 'ok', 'OK',
    '笑死', '真的假', '太扯', '無語言',
    '感謝', '謝啦', '謝謝', '感恩',
  ];
  if (greetings.some(g => clean === g)) return false;
  
  // 4. 纯 hashtag / 純 RT
  if (platform === 'twitter') {
    const noHashtag = text.replace(/#\S+/g, '').replace(/RT\s*@?\S*:?/gi, '').trim();
    if (noHashtag.length < 8) return false;
  }
  
  // 5. 必须包含有意义的内容信号
  return hasContentSignal(clean);
}

// 内容信号检测：游戏关键词 / 讨论性语言 / 足够长度
function hasContentSignal(text) {
  const lower = text.toLowerCase();
  
  // 游戏关键词
  const gameKeywords = [
    '树缘','樹縁','骑士团','騎士団','狂潮','拍照','世界boss','世界王','ワールドボス',
    '时装','皮肤','スキン','ガチャ','抽卡','保底','十連','イベント','活动','奖励',
    '充值','課金','bug','BUG','崩溃','错误','闪退','卡死','空白','合服','服务器',
    '延迟','卡顿','维护','更新','补偿','造型','角色','武器','装备','强化','觉醒',
    '公会','公会战','騎士団戦','竞技','PVP','PVE','副本','转職','签到','庆典',
  ];
  if (gameKeywords.some(k => lower.includes(k.toLowerCase()))) return true;
  
  // 讨论性语言
  const discussionSignals = [
    '覺得','認為','希望','建議','为什么','怎么','是不是','感覺','發現','問題',
    '太好了','太差','受不了','期待','能不能','求求','真的','不行','可以',
    '思う','感じる','なぜ','どうして','欲しい','いいな','ダメ','無理',
  ];
  if (discussionSignals.some(s => lower.includes(s))) return true;
  
  // 長度足够（>20字，说明在表达实质性内容）
  if (text.length > 20) return true;
  
  return false;
}

// ===== 質量评分（0-3）=====
function scoreContentQuality(text, platform) {
  if (!text || !isMessageValuable(text, platform)) return 0;
  
  const lower = text.toLowerCase();
  
  // 游戏关键词
  const gameKeywords = [
    '树缘','樹縁','骑士团','騎士団','狂潮','拍照','世界boss','世界王',
    '时装','皮肤','ガチャ','抽卡','活动','奖励','充值','bug','崩溃',
    '合服','更新','維護','補償','角色','装备','強化',
  ];
  const hasGameKeyword = gameKeywords.some(k => lower.includes(k.toLowerCase()));
  
  // 讨論性語言
  const discussionSignals = [
    '覺得','認為','希望','建議','为什么','怎么','感覺','發現','問題',
    '太好了','太差','受不了','期待','思う','ダメ',
  ];
  const hasDiscussion = discussionSignals.some(s => lower.includes(s));
  
  // Bug 反馈（明确的问题報告）
  const isBugReport = /bug|崩溃|闪退|卡死|錯誤|空白|無法|不能/i.test(text);
  
  // 3 分：游戏关键词 + 讨论性 / 明确 bug / 長文本有实质
  if ((hasGameKeyword && hasDiscussion) || isBugReport || (text.length > 50 && hasGameKeyword)) return 3;
  
  // 2 分：含游戏关键词 或 長度>20有討論性
  if (hasGameKeyword || (text.length > 20 && hasDiscussion)) return 2;
  
  // 1 分：通过过滤但内容较浅
  return 1;
}

// ===== 游戏话题预分类 =====
function classifyGameTopic(text) {
  if (!text) return 'general';
  const lower = text.toLowerCase();
  
  const topicRules = [
    { tag: 'bug_report',     patterns: ['bug','BUG','崩溃','错误','闪退','卡死','空白','无法','不能','失敗'] },
    { tag: 'gacha',          patterns: ['ガチャ','抽卡','抽','保底','池','十連','十连'] },
    { tag: 'knight_order',   patterns: ['骑士团','騎士団','公会','公会战','騎士団戦'] },
    { tag: 'tree_bond',      patterns: ['树缘','樹縁','結緣','社交','互動'] },
    { tag: 'event',          patterns: ['狂潮','活动','イベント','限时','庆典','签到','补偿'] },
    { tag: 'cosmetic',       patterns: ['时装','皮肤','スキン','造型','外观','時裝'] },
    { tag: 'world_boss',     patterns: ['世界boss','世界王','ワールドボス'] },
    { tag: 'photo',          patterns: ['拍照','撮影','截图','寫真'] },
    { tag: 'pricing',        patterns: ['充值','氪金','太贵','性价比','付费','課金','价格'] },
    { tag: 'server',         patterns: ['合服','服务器','延迟','卡顿','維護','更新','伺服器'] },
  ];
  
  for (const rule of topicRules) {
    if (rule.patterns.some(p => lower.includes(p.toLowerCase()))) {
      return rule.tag;
    }
  }
  return 'general';
}

// ===== 获取反馈数据（用于 AI 分析）=====  
// ★ 核心原则：只用 is_noise=0 过滤，不做 quality 限制
// 所有非噪音数据都平等对待，不能因为"质量低"就把用户的发言扔进垃圾桶！
function getQualityFeedback(limit = 50, platform = null, startDate = null, endDate = null) {
  const conditions = ['is_noise = 0'];
  const params = [];
  
  if (platform) {
    conditions.push('platform = ?');
    params.push(platform);
  }
  
  // 时间窗口过滤（锁死前日8:30~今日8:30）
  if (startDate) {
    conditions.push('created_at >= ?');
    params.push(startDate);
  }
  if (endDate) {
    conditions.push('created_at <= ?');
    params.push(endDate);
  }
  
  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  params.push(limit);
  
  // 直接取所有非噪音数据，按时间倒序（最新的优先）
  let rows = db.queryAll(`
    SELECT * FROM sentiment_records 
    ${whereClause}
    ORDER BY created_at DESC 
    LIMIT ?
  `, params);
  
  return rows.map(row => ({
    ...row,
    keywords: row.keywords ? row.keywords.split(',') : []
  }));
}

// ===== 韩国帖子正文清洗（与 routes/lounge.js 的 cleanLoungeContent 同步）=====
function cleanLoungeContent(text) {
  if (!text) return '';
  let t = text;
  t = t.replace(/\d{2,4}[.\/\-]\d{1,2}[.\/\-]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g, ' ');
  t = t.replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ');
  t = t.replace(/(?:作者|작성자|writer|author)\s*[:：]?\s*\S{1,10}/gi, ' ');
  t = t.replace(/\b(?:buff|nerf|버프|너프|추천|비추천|공감|비공감)\b/g, ' ');
  const lines = t.split('\n');
  const cleaned = [];
  let prevLine = '', repeatCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === prevLine && trimmed.length < 50) {
      repeatCount++;
      if (repeatCount <= 2) cleaned.push(trimmed);
    } else { repeatCount = 0; if (trimmed) cleaned.push(trimmed); }
    prevLine = trimmed;
  }
  t = cleaned.join('\n');
  t = t.split('\n').filter(l => l.trim().length >= 3).join('\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

// ===== 韩国社区数据查询（用于热门话题分析）=====
// 打个比方：韩国数据住在另一个“表”里，需要单独叫它来开会
function getLoungeRecordsForAnalysis(startDate, endDate, limit = 30) {
  try {
    const rows = db.queryAll(`
      SELECT 
        id, post_id, title, title_zh, content, content_zh, 
        author, post_time, crawled_at, url, sentiment, 
        ai_category, ai_summary, comment_count, view_count, game_name
      FROM lounge_posts
      WHERE crawled_at >= ? AND crawled_at <= ?
        AND (title_zh IS NOT NULL AND title_zh != '')
      ORDER BY (comment_count + view_count) DESC
      LIMIT ?
    `, [startDate, endDate, limit]);
    
    // ai_category → topic_tag 映射
    const categoryToTag = {
      bug: 'bug_report', suggestion: 'gameplay_balance', complaint: 'general',
      praise: 'general', question: 'general', other: 'general'
    };
    
    const postRecords = rows.map(r => {
      const rawContent = r.content_zh || r.title_zh || r.content || r.title || '';
      const cleanedContent = cleanLoungeContent(rawContent);
      return {
        ...r,
        platform: 'lounge',
        content: cleanedContent,
        translated_content: cleanLoungeContent(r.content_zh || r.title_zh || ''),
        topic_tag: categoryToTag[r.ai_category] || 'general',
        source: 'lounge',
        created_at: r.crawled_at,
        keywords: '',
      };
    });

    // ★ 同时查询评论数据，评论也是玩家声音的重要组成部分
    let commentRecords = [];
    try {
      const comments = db.queryAll(`
        SELECT c.id, c.post_id, c.author, c.content, c.content_zh, 
               c.comment_time, c.sentiment, c.crawled_at, c.likes,
               p.url as post_url, p.title as post_title, p.title_zh as post_title_zh
        FROM lounge_comments c
        LEFT JOIN lounge_posts p ON c.post_id = p.post_id
        WHERE c.crawled_at >= ? AND c.crawled_at <= ?
          AND c.content IS NOT NULL AND c.content != ''
        ORDER BY c.likes DESC
        LIMIT ?
      `, [startDate, endDate, Math.min(limit, 50)]);

      if (comments && comments.length > 0) {
        commentRecords = comments.map(c => {
          const rawContent = c.content_zh || c.content || '';
          return {
            id: c.id,
            post_id: c.post_id,
            platform: 'lounge',
            content: cleanLoungeContent(rawContent),
            translated_content: cleanLoungeContent(c.content_zh || ''),
            topic_tag: 'general',
            source: 'lounge_comment',
            created_at: c.crawled_at,
            keywords: '',
            author: c.author || '匿名',
            sentiment: c.sentiment || 'neutral',
            url: c.post_url || '',
            title: c.post_title_zh || c.post_title || '',
            likes: c.likes || 0,
          };
        });
      }
    } catch (e) {
      log.warn('韩国评论数据查询失败', e.message);
    }

    // 合并帖子 + 评论，评论按 likes 排序后取前面的（更有价值的评论优先）
    return [...postRecords, ...commentRecords];
  } catch (e) {
    console.warn('⚠️ 韩国数据查询失败:', e.message);
    return [];
  }
}

// ===== 回溯标记历史数据 =====
function backfillExistingRecords() {
  console.log('🔄 开始回溯标记历史数据...');
  
  // 修正 Twitter 旧数据的 region 字段（之前默认 'tc'，应为 'jp'）
  try {
    const twWrongRegion = db.queryOne("SELECT COUNT(*) as cnt FROM sentiment_records WHERE platform='twitter' AND region != 'jp'");
    if (twWrongRegion && twWrongRegion.cnt > 0) {
      db.getDb().run("UPDATE sentiment_records SET region = 'jp' WHERE platform = 'twitter'");
      db.saveDb();
      console.log(`   ✅ Twitter region 修正: ${twWrongRegion.cnt} 条 tc→jp`);
    }
  } catch (e) {
    console.warn('   ⚠️ Twitter region 修正失败:', e.message);
  }
  
  const rows = db.queryAll('SELECT id, content, platform FROM sentiment_records WHERE content_quality = 0 AND is_noise = 0');
  
  let noiseCount = 0;
  let qualityCount = 0;
  
  for (const row of rows) {
    const text = row.content || '';
    const platform = row.platform || 'discord';
    
    const noise = isMessageValuable(text, platform) ? 0 : 1;
    const quality = scoreContentQuality(text, platform);
    const tag = classifyGameTopic(text);
    
    db.getDb().run(
      'UPDATE sentiment_records SET is_noise = ?, content_quality = ?, topic_tag = ? WHERE id = ?',
      [noise, quality, tag, row.id]
    );
    
    if (noise) noiseCount++;
    if (quality >= 2) qualityCount++;
  }
  
  db.saveDb();
  console.log(`✅ 回溯完成: 处理 ${rows.length} 条, 标記噪音 ${noiseCount} 条, 高質量 ${qualityCount} 条`);
  return { total: rows.length, noise: noiseCount, quality: qualityCount };
}

// ===== 回填 AI 情感分析（给缺失 ai_sentiment 的记录补上 AI 情感）=====
async function backfillAISentiment() {
  // 优先回填一日舆情窗口内的记录，再补其他时间的
  const { startDate, endDate } = getTodayPeriod();
  
  const windowRows = db.queryAll(`
    SELECT id, content, platform FROM sentiment_records 
    WHERE ai_sentiment IS NULL AND is_noise = 0
    AND created_at >= ? AND created_at <= ?
    ORDER BY id DESC
  `, [startDate, endDate]);
  
  const otherRows = db.queryAll(`
    SELECT id, content, platform FROM sentiment_records 
    WHERE ai_sentiment IS NULL AND is_noise = 0
    AND NOT (created_at >= ? AND created_at <= ?)
    ORDER BY id DESC
    LIMIT ?
  `, [startDate, endDate, Math.max(0, 100 - windowRows.length)]);
  
  const rows = [...windowRows, ...otherRows];
  
  if (!rows || rows.length === 0) {
    console.log('✅ 所有记录均已有 AI 情感，无需回填');
    return 0;
  }
  
  console.log(`🤖 开始回填 AI 情感分析，共 ${rows.length} 条（窗口内 ${windowRows.length} + 其他 ${otherRows.length}）...`);
  let updated = 0;
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const contentLang = translator.hasJapaneseCharacters(row.content) ? 'ja' : 'zh';
      const aiResult = await aiAnalyzer.aiAnalyzeSentiment(row.content, contentLang);
      
      db.getDb().run(
        'UPDATE sentiment_records SET ai_sentiment = ?, ai_confidence = ?, ai_reason = ? WHERE id = ?',
        [aiResult.sentiment, aiResult.confidence, aiResult.reason, row.id]
      );
      updated++;
      
      if ((i + 1) % 5 === 0) {
        console.log(`   🤖 回填进度: ${i + 1}/${rows.length}`);
        db.saveDb();
        await new Promise(r => setTimeout(r, 600));
      }
    } catch (e) {
      console.warn(`   ⚠️ AI 回填失败 (id=${row.id}): ${e.message}`);
    }
  }
  
  if (updated > 0) db.saveDb();
  console.log(`✅ AI 情感回填完成: ${updated}/${rows.length} 条`);
  return updated;
}

// ===== 解析 Yahoo 实时搜索的时间（简化版）=====
// 注意：Yahoo 实时搜索不提供原始发帖时间，只能使用采集时间
function parseYahooTimeFromText(timeText) {
  // 直接返回当前采集时间（ISO 格式）
  return fmtCST8(new Date());
}

// ===== Twitter 数据采集（日服）=====
// ===== Twitter 采集（Yahoo 实时搜索 API）=====
// 完全基于 Python 脚本 yahoo_scraper_v4.py 重写
async function collectFromTwitter(isFullCollect = false) {
  console.log('🐦 开始从 Twitter 采集数据...');
  
  const keywords = ['ツリネバ', 'TOSN', 'TOSNeverland'];
  const searchQuery = keywords.join(' OR ');
  
  try {
    const result = await collectFromYahooApi(searchQuery, isFullCollect);
    // 记录采集状态
    collectionStatus.twitter.lastRun = fmtCST8(new Date());
    collectionStatus.twitter.lastCount = result.length;
    collectionStatus.twitter.lastError = null;
    return result;
  } catch (error) {
    recordError('Twitter采集', error.message);
    collectionStatus.twitter.lastRun = fmtCST8(new Date());
    collectionStatus.twitter.lastError = error.message;
    return [];
  }
}

// ===== Yahoo 实时搜索 API 采集（基于 Python 脚本 yahoo_scraper_v4.py）=====
// 注意：Yahoo 实时搜索的翻页参数 b 已失效（不同 offset 返回相同结果），
// 因此只抓取第1页（约39条），避免重复请求浪费资源
async function collectFromYahooApi(searchQuery, isFullCollect = false) {
  const cheerio = require('cheerio');
  const crypto = require('crypto');
  
  const baseUrl = 'https://search.yahoo.co.jp/realtime/search';
  
  const axiosInstance = axios.create({
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8'
    },
    responseType: 'arraybuffer'  // 获取原始字节，手动解码编码
  });
  
  console.log('🚀 Yahoo 实时搜索 API 采集');
  console.log(`🔍 关键词: ${searchQuery}`);
  console.log(`📄 抓取: 1 页（Yahoo翻页已失效，多页返回相同结果）`);
  
  const allRecords = [];
  const seenSourceIds = new Set();  // 内部去重：同一批次内避免 source_id 重复
  let totalAvailable = 0;
  
  try {
    console.log(`\n📡 正在抓取...`);
    
    const response = await axiosInstance.get(baseUrl, {
      params: { p: searchQuery, ei: 'UTF-8', ifr: 'tl_sc', b: 0 }
    });
    
    // 智能解码：先查 Content-Type 的 charset，Yahoo Japan 有时用 EUC-JP
    const contentType = response.headers['content-type'] || '';
    let charset = 'utf-8';
    const charsetMatch = contentType.match(/charset=([\w-]+)/i);
    if (charsetMatch) charset = charsetMatch[1].toLowerCase();
    
    const iconv = require('iconv-lite');
    const htmlText = iconv.decode(Buffer.from(response.data), charset);
    
    const $ = cheerio.load(htmlText);
    const scriptTag = $('#__NEXT_DATA__');
    if (!scriptTag.length) {
      console.log(`  ❌ 未找到数据`);
      return [];
    }
    
    const data = JSON.parse(scriptTag.text());
    const timeline = data.props.pageProps.pageData.timeline;
    const entries = timeline.entry || [];
    const head = timeline.head || {};
    
    totalAvailable = head.totalResultsAvailable || 0;
    console.log(`  （Yahoo 报告共 ${totalAvailable} 条结果）`);
    
    if (entries.length === 0) {
      console.log('  没有数据');
      return [];
    }
    
    let pageCount = 0;
    let skippedDup = 0;
    for (const entry of entries) {
      // 解析内容
      // Yahoo 实时搜索会用 \tSTART\t关键词\tEND\t 包裹匹配关键词（TAB分隔）
      let content = entry.displayText || entry.displayTextBody || '';
      content = content
        .replace(/\t*START\s*ツリネバ\s*END\t*/g, 'ツリネバ')
        .replace(/\t*START\s*TOSN\s*END\t*/g, 'TOSN')
        .replace(/\t*START\s*TOSNeverland\s*END\t*/g, 'TOSNeverland')
        .replace(/\t*START\s+/g, ' ')
        .replace(/\s+END\t*/g, ' ')
        .replace(/\t+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (!content) continue;
      
      const name = entry.name || '';
      const screenName = entry.screenName || '';
      const author = screenName ? `${name} (@${screenName})` : name;
      
      // 时间转换：Unix时间戳 → 北京时间 CST(UTC+8)
      const createdAt = entry.createdAt;
      let postTime;
      if (createdAt) {
        postTime = new Date(createdAt * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');
      } else {
        postTime = formatCst(nowCst());
      }
      
      const url = entry.url || '';
      // 推文ID：从URL提取，去掉参数
      const tweetId = url ? url.split('/').pop().split('?')[0] : null;
      
      // ===== 内部去重：同一批次内相同 source_id 只保留一条 =====
      if (tweetId) {
        if (seenSourceIds.has(tweetId)) {
          skippedDup++;
          continue;
        }
        seenSourceIds.add(tweetId);
      }
      
      const hasMedia = !!(entry.mediaUrls && entry.mediaUrls.length > 0);
      
      // 生成唯一ID
      const today = fmtCST8(new Date()).substring(0, 10);
      const contentHash = crypto.createHash('md5').update(content).digest('hex').substring(0, 16);
      
      allRecords.push({
        id: `${today}_twitter_${contentHash}_${allRecords.length}`,
        platform: 'twitter',
        source_id: tweetId,
        content: content,
        translated_content: null,
        author: author,
        channel_name: 'Yahoo实时搜索',
        region: 'jp',
        sentiment: 'neutral',
        category: 'general',
        priority: 0,
        created_at: postTime,  // 直接写入北京时间字符串
        processed: 0,
        time_text: null,
        url: url,
        has_media: hasMedia ? 1 : 0
      });
      
      pageCount++;
    }
    
    console.log(`  ✅ 抓到 ${pageCount} 条（Yahoo 报告 ${totalAvailable} 条可用）`);
    if (skippedDup > 0) {
      console.log(`  ⏭️  批次内去重: ${skippedDup} 条`);
    }
    
  } catch (e) {
    console.log(`  ❌ 请求失败: ${e.message.substring(0, 80)}`);
  }
  
  console.log(`\n✅ 采集完成！共 ${allRecords.length} 条唯一推文`);
  return allRecords;
}

// ===== Discord 数据采集（只繁中服）=====
// 打个比方：快递员每次出发前先看小本子——上次送到哪户了？
// 如果本子上有记录，就从那户往后继续取（增量追新）
// 如果没记录（第一次来），就每次敲50户，发现已经来过的就停（智能回填）
async function collectFromDiscord() {
  console.log('💬 开始从 Discord 采集数据...');
  
  // 繁中服 Discord 频道（使用 JP Bot Token 读取，因 TC Bot 未开启 MESSAGE_CONTENT Intent）
  const DISCORD_SERVER = 'JP';
  const tcChannels = [
    { id: '1236867556355346484', name: '💬日常閒聊' },
    { id: '1320748853732970556', name: '👂八卦吃瓜' },
  ];
  
  const BATCH_SIZE = 30; // 每批30条，发现重复就停
  const messageMap = new Map();
  
  console.log(`\n   正在采集 TC（繁中服）Discord 数据...`);
  
  for (const channel of tcChannels) {
    let allNewMessages = [];
    let retries = 0;
    const maxRetries = 2;
    
    const cursor = db.getCollectionCursor(channel.id, DISCORD_SERVER);
    const isBackfill = !cursor;
    
    if (isBackfill) {
      console.log(`     📡 频道: ${channel.name}（首次采集，智能回填模式）`);
    } else {
      console.log(`     📡 频道: ${channel.name}（增量采集，上次追到: ${cursor.last_message_id}）`);
    }
    
    if (isBackfill) {
      // ═══ 智能回填：每次50条，发现重复就停 ═══
      let before = null;
      let batchNum = 0;
      let totalFetched = 0;
      
      while (true) {
        batchNum++;
        let batch = null;
        let batchRetries = 0;
        
        while (batchRetries < maxRetries && !batch) {
          try {
            // 单次 API 调用取 BATCH_SIZE 条
            const url = `${DISCORD_API_BASE}/channels/${channel.id}/messages?limit=${BATCH_SIZE}${before ? `&before=${before}` : ''}`;
            const axiosConfig = {
              headers: { 'Authorization': `Bot ${getDiscordToken(DISCORD_SERVER)}`, 'Content-Type': 'application/json' },
              timeout: 30000,
            };
            const resp = await axios.get(url, axiosConfig);
            if (Array.isArray(resp.data) && resp.data.length > 0) {
              batch = resp.data;
            } else {
              batch = []; // 空数组 = 没有更多消息
            }
          } catch (e) {
            batchRetries++;
            if (e.response?.status === 401) {
              recordError('Discord采集', `${DISCORD_SERVER} Bot Token无效或已过期！`);
              break;
            }
            if (batchRetries < maxRetries) {
              console.log(`        ⚠️ 第${batchNum}批获取失败，重试... (${e.message})`);
              await new Promise(r => setTimeout(r, 5000));
            }
          }
        }
        
        if (!batch || batch.length === 0) {
          console.log(`        📭 第${batchNum}批: 没有更多消息，频道到底`);
          break;
        }
        
        totalFetched += batch.length;
        
        // 检查这批中有多少已存在于数据库
        let dupCount = 0;
        for (const msg of batch) {
          if (msg.author?.bot || !(msg.content || '').trim()) continue;
          const exists = db.queryOne('SELECT id FROM sentiment_records WHERE platform = ? AND source_id = ?', ['discord', msg.id]);
          if (exists) dupCount++;
        }
        
        console.log(`        📦 第${batchNum}批: ${batch.length} 条（新增 ${batch.length - dupCount}，重复 ${dupCount}）`);
        
        if (dupCount > 0) {
          // 发现重复 → 停止，这批的新消息仍然收进来
          const newInBatch = batch.filter(m => {
            if (m.author?.bot || !(m.content || '').trim()) return false;
            return !db.queryOne('SELECT id FROM sentiment_records WHERE platform = ? AND source_id = ?', ['discord', m.id]);
          });
          allNewMessages.push(...newInBatch);
          console.log(`        🛑 发现${dupCount}条重复，停止往更早时间抓取`);
          break;
        }
        
        // 全部是新消息，收下，继续往更早翻
        allNewMessages.push(...batch);
        
        if (batch.length < BATCH_SIZE) {
          console.log(`        📭 第${batchNum}批: 返回不足${BATCH_SIZE}条，频道到底`);
          break;
        }
        
        before = batch[batch.length - 1].id; // 最旧的消息作为下一批游标
        await new Promise(r => setTimeout(r, 300)); // 防限流
      }
      
      console.log(`        📊 总计: 获取 ${totalFetched} 条，其中新增 ${allNewMessages.length} 条`);
    } else {
      // ═══ 增量采集：从游标之后取新消息 ═══
      try {
        allNewMessages = await fetchMessagesAfter(channel.id, DISCORD_SERVER, cursor.last_message_id, 500);
        if (!Array.isArray(allNewMessages)) allNewMessages = [];
        console.log(`        ✅ 增量获取 ${allNewMessages.length} 条`);
      } catch (e) {
        if (e.response?.status === 401) {
          recordError('Discord采集', `${DISCORD_SERVER} Bot Token无效或已过期！`);
        } else {
          recordError('Discord采集', `Discord增量采集失败: ${e.message}`);
        }
        allNewMessages = [];
      }
    }
    
    // ═══ 处理消息（去重 + 过滤 + 游标更新）═══
    if (allNewMessages.length > 0) {
      let validCount = 0;
      let newestMsgId = cursor ? cursor.last_message_id : null;
      
      for (const msg of allNewMessages) {
        const content = msg.content || '';
        if (!content.trim() || msg.author?.bot) continue;
        
        validCount++;
        if (!newestMsgId || BigInt(msg.id) > BigInt(newestMsgId)) {
          newestMsgId = msg.id;
        }
        
        const author = msg.author?.global_name || msg.author?.username || '未知用户';
        const crypto = require('crypto');
        const contentPreview = content.substring(0, 100);
        const contentHash = crypto.createHash('md5').update(contentPreview).digest('hex').substring(0, 16);
        const uniqueKey = `${author}_${contentHash}`;
        
        if (messageMap.has(uniqueKey)) {
          const existing = messageMap.get(uniqueKey);
          if (!existing.channels.includes(channel.name)) existing.channels.push(channel.name);
          if (msg.timestamp && (!existing.firstMessage.timestamp || msg.timestamp < existing.firstMessage.timestamp)) {
            existing.firstMessage.timestamp = msg.timestamp;
            existing.firstMessage.source_id = msg.id;
          }
        } else {
          let cstTimeStr;
          try {
            cstTimeStr = formatCst(new Date(msg.timestamp));
          } catch (e) {
            cstTimeStr = formatCst(nowCst());
          }
          messageMap.set(uniqueKey, {
            channels: [channel.name],
            firstMessage: { platform: 'discord', source_id: msg.id, content, author, timestamp: cstTimeStr, region: 'tc' }
          });
        }
      }
      
      if (newestMsgId && validCount > 0) {
        const oldTotal = cursor ? cursor.total_collected : 0;
        db.updateCollectionCursor(channel.id, 'TC', channel.name, newestMsgId, oldTotal + validCount);
        console.log(`         📌 游标已更新: ${newestMsgId}（累计 ${oldTotal + validCount} 条）`);
      }
      console.log(`         有效消息: ${validCount} 条`);
    } else if (isBackfill) {
      console.log(`        ⚠️ 智能回填未获取到任何新消息`);
    } else {
      console.log(`        ✅ 没有新消息`);
    }
  }
  
  // 转换为最终结果
  const collected = Array.from(messageMap.values()).map(item => ({
    ...item.firstMessage,
    channel_name: item.channels.join(', ')
  }));
  
  collectionStatus.discord.lastRun = fmtCST8(new Date());
  collectionStatus.discord.lastCount = collected.length;
  if (collected.length === 0) {
    collectionStatus.discord.lastError = '采集结果为0条，可能存在问题';
    recordError('Discord采集', '本次采集结果为0条，请检查Token和网络');
  } else {
    collectionStatus.discord.lastError = null;
  }
  
  console.log(`\n✅ 从 Discord（繁中服）共采集到 ${collected.length} 条玩家发言（已去重）`);
  return collected;
}

// ===== 保存舆情记录 =====
async function saveSentimentRecord(record, enableAI = false) {
  // ===== 去重检查：同一平台 + 相同内容视为重复 =====
  if (record.content) {
    const normalizedContent = record.content.replace(/\s+/g, ' ').trim();
    
    // 优先用 source_id 精确匹配
    if (record.source_id) {
      const bySourceId = db.queryOne(
        'SELECT id FROM sentiment_records WHERE platform = ? AND source_id = ?',
        [record.platform, record.source_id]
      );
      if (bySourceId) {
        return { success: false, translated: false, skipped: true, reason: 'source_id重复' };
      }
    }
    
    // 再用 platform + content 内容匹配（防止 source_id 不同但内容相同）
    const byContent = db.queryOne(
      'SELECT id FROM sentiment_records WHERE platform = ? AND content = ?',
      [record.platform, normalizedContent]
    );
    if (byContent) {
      return { success: false, translated: false, skipped: true, reason: '内容重复' };
    }
  }

  const { sentiment, score } = analyzeSentiment(record.content);
  const keywords = extractKeywords(record.content);
  const category = classifyContent(record.content);
  
  // 噪音过滤 + 质量评分 + 话题分类
  const valuable = isMessageValuable(record.content, record.platform);
  
  // 乱码检测：入库前检查，乱码数据直接不收（比喻：仓库门口质检员）
  const contentBuf = Buffer.from(record.content || '');
  const replacementChars = (contentBuf.toString('hex').match(/efbfbd/g) || []).length;
  const isGarbled = replacementChars >= 3;
  
  const isNoise = (valuable && !isGarbled) ? 0 : 1;
  const contentQuality = scoreContentQuality(record.content, record.platform);
  const topicTag = classifyGameTopic(record.content);
  
  // 计算优先级
  let priority = 0;
  if (sentiment === 'negative') priority += 2;
  if (category === 'bug') priority += 2;
  if (category === 'complaint') priority += 1;
  if (keywords.some(k => ['BUG', '崩溃', '无法登录'].includes(k))) priority += 1;
  
  // 翻译和 AI 分析：噪音记录跳过，节省 API 调用
  let translatedContent = null;
  let aiSentiment = null;
  let aiConfidence = null;
  let aiReason = null;
  let aiCategory = null;
  
  if (!isNoise) {
    // 只要包含日文字符就翻译（Twitter 日服、Discord 日服等）
    if (translator.hasJapaneseCharacters(record.content)) {
      try {
        translatedContent = await translator.translateJapaneseToChinese(record.content);
        if (translatedContent !== record.content) {
          console.log(`   ✅ 翻译成功 (${record.content.length}字符)`);
        }
      } catch (e) {
        console.warn('⚠️ 翻译失败，跳过翻译:', e.message);
      }
    }
    
    // AI 分析（可选，避免频繁调用 API）
    if (enableAI) {
      try {
        const contentLang = translator.hasJapaneseCharacters(record.content) ? 'ja' : 'zh';
        const aiResult = await aiAnalyzer.aiAnalyzeSentiment(record.content, contentLang);
        aiSentiment = aiResult.sentiment;
        aiConfidence = aiResult.confidence;
        aiReason = aiResult.reason;
        const aiCat = await aiAnalyzer.aiClassifyFeedback(record.content);
        aiCategory = aiCat;
      } catch (e) {
        console.warn('⚠️ AI 分析失败，跳过:', e.message);
      }
    }
  }
  
  const sql = `
    INSERT INTO sentiment_records 
    (platform, source_id, content, translated_content, author, channel_name, 
     sentiment, ai_sentiment, ai_confidence, ai_reason, ai_category, 
     keywords, category, priority, created_at, is_noise, content_quality, topic_tag,
     time_text, url, has_media, region)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  
  // 处理时间字段：统一转换为 YYYY-MM-DD HH:MM:SS 标准格式
  let createdAt;
  const timeValue = record.created_at || record.timestamp;
  
  if (timeValue) {
    createdAt = normalizeDateTime(timeValue);
  } else {
    createdAt = formatCst(nowCst());
  }
  
  const params = [
    record.platform,
    record.source_id,
    record.content,
    translatedContent,
    record.author,
    record.channel_name,
    sentiment,
    aiSentiment,
    aiConfidence,
    aiReason,
    aiCategory,
    keywords.join(','),
    category,
    priority,
    createdAt,
    isNoise,
    contentQuality,
    topicTag,
    record.time_text || null,  // Yahoo页面显示的时间文本
    record.url || null,        // Twitter原帖链接（清理后）
    record.has_media ? 1 : 0,  // 是否带图/视频
    record.region || 'tc'      // 服务器区域
  ];
  
  try {
    db.getDb().run(sql, params);
    db.saveDb();
    return { success: true, translated: !!translatedContent };
  } catch (e) {
    console.error('保存舆情记录失败:', e.message || e);
    return { success: false, translated: false };
  }
}

// ===== 官方/运营发言过滤 =====
// 比喻：仓库入口的"保安"，把官方公告和运营发言挑出来，不让它们混进玩家发言区
const OFFICIAL_AUTHORS = [
  { platform: 'discord', author: '小梅' },
  { platform: 'twitter', author: 'ツリーオブセイヴァー：ネバーランド' },
];
const OFFICIAL_KEYWORDS = ['运营公告', '官方公告', 'GM公告', '维护通知', '官方通知', '运营通知'];

function filterOfficialRecords(records) {
  const official = [];
  const normal = [];
  for (const r of records) {
    const author = (r.author || '').trim();
    const content = r.content || '';
    // 规则1：精确匹配官方账号
    const isOfficialAuthor = OFFICIAL_AUTHORS.some(
      o => o.platform === r.platform && author === o.author
    );
    // 规则2：内容包含运营/官方关键词
    const hasOfficialKeyword = OFFICIAL_KEYWORDS.some(kw => content.includes(kw));
    if (isOfficialAuthor || hasOfficialKeyword) {
      official.push(r);
    } else {
      normal.push(r);
    }
  }
  return { official, normal };
}

// ===== 内存去重（入库前快速过滤） =====
function deduplicateRecords(records) {
  const seen = new Set();
  const unique = [];
  let dupCount = 0;
  for (const r of records) {
    const key = `${r.platform}::${(r.content || '').replace(/\s+/g, ' ').trim()}`;
    if (seen.has(key)) {
      dupCount++;
      continue;
    }
    seen.add(key);
    unique.push(r);
  }
  return { records: unique, dupCount };
}

// ===== 分析快照（用于检测数据是否变更） =====
let analysisSnapshot = { recordCount: 0, maxUpdatedAt: null, analyzedAt: null };

function getAnalysisSnapshot() { return { ...analysisSnapshot }; }
function setAnalysisSnapshot(snap) { analysisSnapshot = { ...snap }; }

function getCurrentDataSnapshot() {
  const row = db.queryOne(
    'SELECT COUNT(*) as cnt, MAX(created_at) as maxAt FROM sentiment_records'
  );
  let loungeCount = 0;
  let loungeMaxAt = null;
  try {
    const lr = db.queryOne(
      'SELECT COUNT(*) as cnt, MAX(crawled_at) as maxAt FROM lounge_posts'
    );
    loungeCount = lr?.cnt || 0;
    loungeMaxAt = lr?.maxAt || null;
  } catch (_) {}
  const totalCount = (row ? row.cnt : 0) + loungeCount;
  const maxAt = row?.maxAt && loungeMaxAt
    ? (row.maxAt > loungeMaxAt ? row.maxAt : loungeMaxAt)
    : (row?.maxAt || loungeMaxAt);
  return {
    recordCount: totalCount,
    maxUpdatedAt: maxAt,
  };
}

// ===== 批量保存 =====
async function batchSaveRecords(records, enableAI = false) {
  let success = 0;
  let failed = 0;
  let skipped = 0;
  let translated = 0; // 统计翻译数量
  
  console.log(`📦 开始保存 ${records.length} 条记录...`);
  if (enableAI) {
    console.log('   🤖 AI 分析已启用（可能较慢）');
  }
  
  // 如果启用 AI，只处理前 20 条以避免 API 限流
  const maxAIRecords = enableAI ? records.length : 0; // AI 分析覆盖所有记录
  
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    
    // 去重检查已由 saveSentimentRecord 内部完成，不在此重复查询
    const useAI = enableAI;
    
    const result = await saveSentimentRecord(record, useAI);
    if (result.skipped) {
      skipped++;
    } else if (result.success) {
      success++;
      if (result.translated) translated++;
    } else {
      failed++;
    }
    
    // 每处理 5 条记录，暂停一下避免 API 限流
    // 如果有日语内容需要翻译，增加延迟
    const hasJapanese = translator.hasJapaneseCharacters(record.content);
    const delay = hasJapanese ? 800 : 500; // 日语内容多等300ms用于翻译
    
    if ((i + 1) % 5 === 0) {
      console.log(`   ⏸️  已处理 ${i + 1}/${records.length} 条，暂停 ${delay/1000}秒...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  console.log(`✅ 保存完成: 新增 ${success} 条，翻译 ${translated} 条，跳过 ${skipped} 条，失败 ${failed} 条`);
  return { success, failed, skipped, translated };
}

// ===== 历史数据去重 =====
function deduplicateHistoricalData() {
  console.log('🧹 开始历史数据去重清理...');
  
  // 找出所有重复组：相同 platform + content 有多条记录
  const duplicates = db.queryAll(`
    SELECT platform, content, COUNT(*) as cnt
    FROM sentiment_records
    WHERE content IS NOT NULL AND content != ''
    GROUP BY platform, content
    HAVING cnt > 1
    ORDER BY cnt DESC
  `);
  
  let totalDuplicates = 0;
  let duplicateGroups = 0;
  
  for (const group of duplicates) {
    // 对每组重复，保留 id 最小（最早入库）的那条，删除其余
    const records = db.queryAll(
      'SELECT id FROM sentiment_records WHERE platform = ? AND content = ? ORDER BY id ASC',
      [group.platform, group.content]
    );
    
    const keepId = records[0].id;
    const removeIds = records.slice(1).map(r => r.id);
    
    for (const removeId of removeIds) {
      db.getDb().run('DELETE FROM sentiment_records WHERE id = ?', [removeId]);
      totalDuplicates++;
    }
    duplicateGroups++;
  }
  
  if (totalDuplicates > 0) {
    db.saveDb();
  }
  
  const remaining = db.queryOne('SELECT COUNT(*) as cnt FROM sentiment_records');
  console.log(`✅ 去重完成: ${duplicateGroups} 组重复，删除 ${totalDuplicates} 条，剩余 ${remaining.cnt} 条`);
  return { duplicateGroups, deleted: totalDuplicates, remaining: remaining.cnt };
}

// ===== 获取统计数据（新版：Twitter + Discord）=====
function getStatistics(period = 'week') {
  let startDate, endDate, periodLabel;
  
  if (period === 'today') {
    // 舆情监控面板：前一日 8:30 到 今日 8:30
    const { startDate: s, endDate: e, periodLabel: label } = getTodayPeriod();
    startDate = s;
    endDate = e;
    periodLabel = label;
  } else {
    // 周报：上周一 00:00 到 上周日 23:59
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=周日, 1=周一...
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    
    const startOfLastMonday = new Date(now);
    startOfLastMonday.setDate(now.getDate() - daysSinceMonday - 7);
    startOfLastMonday.setHours(0, 0, 0, 0);
    
    const endOfLastSunday = new Date(startOfLastMonday);
    endOfLastSunday.setDate(startOfLastMonday.getDate() + 6);
    endOfLastSunday.setHours(23, 59, 59, 999);
    
    startDate = fmtCST8(startOfLastMonday);
    endDate = fmtCST8(endOfLastSunday);
    periodLabel = `${startOfLastMonday.getFullYear()}/${startOfLastMonday.getMonth()+1}/${startOfLastMonday.getDate()} ~ ${endOfLastSunday.getFullYear()}/${endOfLastSunday.getMonth()+1}/${endOfLastSunday.getDate()}`;
  }
  
  console.log(`📅 统计周期: ${periodLabel}`);
  
  // Twitter 数据统计（AI 情感优先，规则情感兆底，过滤噪音）
  const twitterCount = db.queryOne(
    `SELECT COUNT(*) as cnt FROM sentiment_records 
     WHERE platform = 'twitter' AND is_noise = 0
     AND created_at >= '${startDate}' AND created_at <= '${endDate}'`
  );
  
  const twitterSentiment = db.queryAll(
    `SELECT COALESCE(ai_sentiment, sentiment) as sentiment, COUNT(*) as cnt FROM sentiment_records 
     WHERE platform = 'twitter' AND is_noise = 0
     AND created_at >= '${startDate}' AND created_at <= '${endDate}'
     GROUP BY COALESCE(ai_sentiment, sentiment)`
  );
  
  // Discord 数据统计（AI 情感优先，规则情感兆底，过滤噪音）
  const discordCount = db.queryOne(
    `SELECT COUNT(*) as cnt FROM sentiment_records 
     WHERE platform = 'discord' AND is_noise = 0
     AND created_at >= '${startDate}' AND created_at <= '${endDate}'`
  );
  
  const discordSentiment = db.queryAll(
    `SELECT COALESCE(ai_sentiment, sentiment) as sentiment, COUNT(*) as cnt FROM sentiment_records 
     WHERE platform = 'discord' AND is_noise = 0
     AND created_at >= '${startDate}' AND created_at <= '${endDate}'
     GROUP BY COALESCE(ai_sentiment, sentiment)`
  );
  
  // 按区域统计（过滤噪音）
  const regionStats = db.queryAll(
    `SELECT region, COUNT(*) as cnt FROM sentiment_records 
     WHERE is_noise = 0
     AND created_at >= '${startDate}' AND created_at <= '${endDate}'
     AND region IS NOT NULL
     GROUP BY region
     ORDER BY cnt DESC`
  );
  
  // 提取热门话题（按 topic_tag 分组，比 keywords 更准确）
  const twitterTopics = db.queryAll(
    `SELECT topic_tag, COUNT(*) as cnt FROM sentiment_records 
     WHERE platform = 'twitter' AND is_noise = 0
     AND created_at >= '${startDate}' AND created_at <= '${endDate}'
     AND topic_tag IS NOT NULL AND topic_tag != 'general'
     GROUP BY topic_tag
     ORDER BY cnt DESC
     LIMIT 8`
  );
  
  const discordTopics = db.queryAll(
    `SELECT topic_tag, COUNT(*) as cnt FROM sentiment_records 
     WHERE platform = 'discord' AND is_noise = 0
     AND created_at >= '${startDate}' AND created_at <= '${endDate}'
     AND topic_tag IS NOT NULL AND topic_tag != 'general'
     GROUP BY topic_tag
     ORDER BY cnt DESC
     LIMIT 8`
  );
  
  // ===== 韩国社区数据 =====
  let loungeCount = 0;
  let loungeSentiment = { positive: 0, neutral: 0, negative: 0 };
  let loungeTopics = []; // ★ L1574: 韩服话题列表
  try {
    const loungeRow = db.queryOne(
      `SELECT COUNT(*) as cnt FROM lounge_posts WHERE crawled_at >= '${startDate}' AND crawled_at <= '${endDate}'`
    );
    loungeCount = loungeRow?.cnt || 0;
    const loungeSentRows = db.queryAll(
      `SELECT sentiment, COUNT(*) as cnt FROM lounge_posts WHERE crawled_at >= '${startDate}' AND crawled_at <= '${endDate}' GROUP BY sentiment`
    );
    loungeSentRows.forEach(r => { if (loungeSentiment[r.sentiment] !== undefined) loungeSentiment[r.sentiment] = r.cnt; });
    
    // ★ L1578: 查询 Naver Lounge 话题标签（按 game_code 分组）
    const loungeTopicRows = db.queryAll(
      `SELECT game_code, COUNT(*) as cnt FROM lounge_posts 
       WHERE crawled_at >= '${startDate}' AND crawled_at <= '${endDate}' 
       AND game_code IS NOT NULL AND game_code != ''
       GROUP BY game_code
       ORDER BY cnt DESC
       LIMIT 8`
    );
    loungeTopics = loungeTopicRows.map(r => ({
      name: r.game_code,
      tag: r.game_code,
      count: r.cnt
    }));
  } catch (_) { /* lounge表可能不存在 */ }

  // 计算风险等级（Twitter + Discord + Lounge 综合负面比例）
  const twNeg = twitterSentiment.find(r => r.sentiment === 'negative')?.cnt || 0;
  const twTotal = twitterCount?.cnt || 0;
  const dcNeg = discordSentiment.find(r => r.sentiment === 'negative')?.cnt || 0;
  const dcTotal = discordCount?.cnt || 0;
  const loungeNeg = loungeSentiment.negative;
  const totalNeg = twNeg + dcNeg + loungeNeg;
  const totalCount = twTotal + dcTotal + loungeCount;
  const negativeRatio = totalNeg / Math.max(totalCount, 1);
  
  let riskLevel = 'low';
  if (negativeRatio > 0.4) {
    riskLevel = 'high';
  } else if (negativeRatio > 0.2) {
    riskLevel = 'medium';
  }
  
  return {
    twitter_count: twitterCount?.cnt || 0,
    discord_count: discordCount?.cnt || 0,
    lounge_count: loungeCount,
    risk_level: riskLevel,
    period: periodLabel,
    // 新增：区域分布统计
    region_distribution: regionStats.map(r => ({
      region: r.region,
      count: r.cnt,
      label: r.region === 'tc' ? '繁中' : r.region === 'jp' ? '日服' : r.region.toUpperCase()
    })),
    twitter_sentiment: {
      positive: twitterSentiment.find(r => r.sentiment === 'positive')?.cnt || 0,
      neutral: twitterSentiment.find(r => r.sentiment === 'neutral')?.cnt || 0,
      negative: twitterSentiment.find(r => r.sentiment === 'negative')?.cnt || 0
    },
    discord_sentiment: {
      positive: discordSentiment.find(r => r.sentiment === 'positive')?.cnt || 0,
      neutral: discordSentiment.find(r => r.sentiment === 'neutral')?.cnt || 0,
      negative: discordSentiment.find(r => r.sentiment === 'negative')?.cnt || 0
    },
    lounge_sentiment: loungeSentiment,
    twitter_topics: twitterTopics.map(r => ({
      name: getTopicTagLabel(r.topic_tag),
      tag: r.topic_tag,
      count: r.cnt
    })),
    discord_topics: discordTopics.map(r => ({
      name: getTopicTagLabel(r.topic_tag),
      tag: r.topic_tag,
      count: r.cnt
    })),
    lounge_topics: loungeTopics // ★ L1639: 返回韩服话题
  };
}

// ===== 获取最新反馈列表 =====
function getRecentFeedback(limit = 50, filters = {}) {
  const conditions = ['is_noise = 0'];
  const params = [];
  
  if (filters.platform) {
    conditions.push('platform = ?');
    params.push(filters.platform);
  }
  
  if (filters.sentiment) {
    conditions.push('COALESCE(ai_sentiment, sentiment) = ?');
    params.push(filters.sentiment);
  }
  
  if (filters.category) {
    conditions.push('category = ?');
    params.push(filters.category);
  }
  
  if (filters.priority !== undefined) {
    conditions.push('priority >= ?');
    params.push(filters.priority);
  }
  
  const whereClause = conditions.length > 0 
    ? `WHERE ${conditions.join(' AND ')}` 
    : '';
  
  params.push(limit);
  
  const rows = db.queryAll(`
    SELECT * FROM sentiment_records 
    ${whereClause}
    ORDER BY created_at DESC 
    LIMIT ?
  `, params);
  
  return rows.map(row => ({
    ...row,
    keywords: row.keywords ? row.keywords.split(',') : []
  }));
}

// ===== 标记为已处理 =====
function markAsProcessed(recordId, handler) {
  try {
    db.getDb().run(
      'UPDATE sentiment_records SET processed = 1, handler = ? WHERE id = ?',
      [handler, recordId]
    );
    db.saveDb();
  } catch (e) {
    console.error('❌ 标记已处理失败:', e.message);
    throw e;
  }
}

// ===== 获取一日内舆情（每日8:30采集的发言原声）=====
function getDailySentiment(limit = 200, platform = null) {
  const { startDate, endDate } = getTodayPeriod();
  
  console.log(`📅 一日内舆情周期: ${startDate} ~ ${endDate}`);
  
  let whereClause = `created_at >= '${startDate}' AND created_at <= '${endDate}' AND is_noise = 0`;
  let params = [];
  
  if (platform) {
    whereClause += ` AND platform = '${platform}'`;
  }
  
  params.push(limit);
  
  const rows = db.queryAll(`
    SELECT id, platform, source_id, content, translated_content, author, 
           channel_name, region, 
           COALESCE(ai_sentiment, sentiment) as sentiment,
           ai_sentiment, ai_confidence, ai_reason, ai_category,
           keywords, category, priority, created_at,
           is_noise, content_quality, topic_tag, time_text, url, has_media
    FROM sentiment_records 
    WHERE ${whereClause}
    ORDER BY priority DESC, created_at DESC 
    LIMIT ?
  `, params);
  
  return rows.map(row => ({
    ...row,
    keywords: row.keywords ? row.keywords.split(',') : []
  }));
}

// ===== 获取情绪倾向分析（新增）=====
function getSentimentTrendAnalysis(platform = null, days = 7) {
  // ★ 直接计算 UTC+8 日期，不用偏移Date
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(now.getDate() - days);
  startDate.setHours(0, 0, 0, 0);
  const startStr = fmtCST8(startDate);
  
  // 基础统计
  const baseConditions = ['is_noise = 0', 'created_at >= ?'];
  const baseParams = [startStr];
  if (platform) {
    baseConditions.push('platform = ?');
    baseParams.push(platform);
  }
  
  const whereSQL = baseConditions.join(' AND ');
  
  const totalStats = db.queryOne(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN COALESCE(ai_sentiment, sentiment) = 'positive' THEN 1 ELSE 0 END) as positive,
            SUM(CASE WHEN COALESCE(ai_sentiment, sentiment) = 'negative' THEN 1 ELSE 0 END) as negative,
            SUM(CASE WHEN COALESCE(ai_sentiment, sentiment) = 'neutral' THEN 1 ELSE 0 END) as neutral
     FROM sentiment_records 
     WHERE ${whereSQL}`,
    [...baseParams]
  );
  
  // 按天统计趋势
  const dailyTrend = db.queryAll(
    `SELECT DATE(created_at) as date,
            COUNT(*) as count,
            SUM(CASE WHEN COALESCE(ai_sentiment, sentiment) = 'positive' THEN 1 ELSE 0 END) as positive,
            SUM(CASE WHEN COALESCE(ai_sentiment, sentiment) = 'negative' THEN 1 ELSE 0 END) as negative
     FROM sentiment_records 
     WHERE ${whereSQL}
     GROUP BY DATE(created_at)
     ORDER BY date DESC`,
    [...baseParams]
  );
  
  // 提取负面情绪关键词
  const negativeKeywords = db.queryAll(
    `SELECT topic_tag, COUNT(*) as cnt FROM sentiment_records 
     WHERE COALESCE(ai_sentiment, sentiment) = 'negative'
     AND ${whereSQL}
     AND topic_tag IS NOT NULL
     GROUP BY topic_tag
     ORDER BY cnt DESC
     LIMIT 5`,
    [...baseParams]
  );
  
  // 计算整体情绪倾向
  const total = totalStats?.total || 1;
  const positiveRatio = ((totalStats?.positive || 0) / total * 100).toFixed(1);
  const negativeRatio = ((totalStats?.negative || 0) / total * 100).toFixed(1);
  const neutralRatio = ((totalStats?.neutral || 0) / total * 100).toFixed(1);
  
  // 判断整体倾向
  let overallTrend = 'stable';
  if (parseFloat(negativeRatio) > parseFloat(positiveRatio) + 20) {
    overallTrend = 'negative';
  } else if (parseFloat(positiveRatio) > parseFloat(negativeRatio) + 20) {
    overallTrend = 'positive';
  }
  
  return {
    period: `${days}天`,
    total_messages: total,
    overall_trend: overallTrend,
    sentiment_ratio: {
      positive: `${positiveRatio}%`,
      negative: `${negativeRatio}%`,
      neutral: `${neutralRatio}%`
    },
    daily_trend: dailyTrend.slice(0, 7), // 最近7天
    pain_points: negativeKeywords.map(k => ({
      tag: k.topic_tag,
      count: k.cnt,
      label: getTopicTagLabel(k.topic_tag)
    }))
  };
}

// 辅助函数：获取话题标签中文名称
function getTopicTagLabel(tag) {
  const labels = {
    bug_report: 'Bug反馈',
    gacha: '抽卡系统',
    knight_order: '骑士团/公会',
    tree_bond: '树缘系统',
    event: '活动玩法',
    cosmetic: '时装/皮肤',
    world_boss: '世界Boss',
    photo: '拍照功能',
    pricing: '充值/定价',
    server: '服务器问题',
    social: '社交互动',
    gameplay_balance: '游戏平衡',
    general: '其他'
  };
  // auto_ 前缀是 AI 哨兵发现的新话题，直接显示原始标签名
  if (tag && tag.startsWith('auto_')) {
    return '🆕 ' + tag.replace('auto_', '').replace(/_/g, ' ');
  }
  return labels[tag] || tag || '未分类';
}

// ===== 获取今日采集数据（昨天8:30~今天8:30，全量展示）=====
function getRealtimeFeedback(limit = 1000, filters = {}) {
  const { startDate, endDate } = getTodayPeriod();
  
  const conditions = ['created_at >= ?', 'created_at <= ?', 'is_noise = 0'];
  const params = [startDate, endDate];
  
  if (filters.platform) {
    conditions.push('platform = ?');
    params.push(filters.platform);
  }
  
  if (filters.sentiment) {
    conditions.push('COALESCE(ai_sentiment, sentiment) = ?');
    params.push(filters.sentiment);
  }
  
  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  
  params.push(limit);
  
  const rows = db.queryAll(`
    SELECT id, platform, source_id, content, translated_content, author, 
           channel_name, region, 
           COALESCE(ai_sentiment, sentiment) as sentiment,
           ai_sentiment, ai_confidence, ai_reason, ai_category,
           keywords, category, priority, created_at,
           is_noise, content_quality, topic_tag, time_text, url, has_media
    FROM sentiment_records 
    ${whereClause}
    ORDER BY created_at DESC 
    LIMIT ?
  `, params);
  
  return rows.map(row => ({
    ...row,
    keywords: row.keywords ? row.keywords.split(',') : []
  }));
}

// ===== 保存话题历史（带去重保护：同天同平台同话题只存一份）=====
function saveTopicHistory(topics, platform, skipDedup = false) {
  try {
    const now = fmtCST8(new Date());
    const todayStr = now.substring(0, 10);
    
    // ★ 如果调用方已保证数据去重（如从 hot-topics API 来的），跳过内部去重逻辑
    let dedupedTopics = topics;
    
    if (!skipDedup) {
      // 原有去重逻辑：按 topic_tag 做二次去重
      // AI 可能返回相似标题（如"抽卡掉率争议" vs "SSR掉率太低"），但 tag 相同
      // 这里强制合并同 tag 的话题，避免重复
      
      // 第一步：标准化 tag（使用全局统一函数）
      for (const topic of topics) {
        topic.tag = aiAnalyzer.standardizeTag(topic.tag);
      }
      
      const tagGroups = {};
      for (const topic of topics) {
        const tag = topic.tag || 'general';
        if (!tagGroups[tag]) {
          tagGroups[tag] = [];
        }
        tagGroups[tag].push(topic);
      }
      
      // 每个 tag 只保留一个话题（合并数据）
      dedupedTopics = [];
      for (const [tag, group] of Object.entries(tagGroups)) {
        if (group.length === 1) {
          dedupedTopics.push(group[0]);
        } else {
          // 多个同 tag 话题 → 合并
          const merged = {
            title: group[0].title,  // 使用第一个的标题
            summary: group.map(t => t.summary).filter(s => s).join('; '),  // 合并摘要
            detail: group.map(t => t.detail).filter(d => d).join('\n'),  // 合并详情
            sentiment: group.find(t => t.sentiment === 'negative')?.sentiment || 
                       group.find(t => t.sentiment === 'positive')?.sentiment || 'neutral',
            tag: tag,
            action: group.map(t => t.action).filter(a => a).join('; '),  // 合并建议
            count: group.reduce((sum, t) => sum + (t.count || 0), 0),  // 累加讨论数
            heat: Math.max(...group.map(t => t.heat || 0)),  // 取最高热度
            representative_quotes: group.flatMap(t => t.representative_quotes || []),  // 合并原声
            urls: Array.from(new Set(group.flatMap(t => t.urls || [])))  // 合并链接（去重）
          };
          dedupedTopics.push(merged);
          console.log(`   🧹 合并同tag话题: ${tag} (${group.length}个 → 1个)`);
        }
      }
    }
    
    // 获取上次的话题数据（用于对比）
    const previousTopics = db.queryAll(`
      SELECT topic_title, heat_score 
      FROM topic_history 
      WHERE platform = ? 
      ORDER BY created_at DESC 
      LIMIT 10
    `, [platform]);
    
    const previousMap = {};
    previousTopics.forEach(t => {
      previousMap[t.topic_title] = t.heat_score;
    });
    
    let inserted = 0, updated = 0;
    
    // 插入或更新话题记录
    dedupedTopics.forEach(topic => {
      const prevHeat = previousMap[topic.title] || 0;
      const heatChange = topic.heat - prevHeat;
      const isNew = prevHeat === 0 ? 1 : 0;
      
      let trend = 'stable';
      if (heatChange > 1) trend = 'rising';
      else if (heatChange < -1) trend = 'falling';
      
      // 去重检查：同天同平台同话题是否已存在
      const existing = db.queryOne(
        `SELECT id FROM topic_history 
         WHERE platform = ? AND topic_title = ? AND DATE(created_at) = ?`,
        [platform, topic.title, todayStr]
      );
      
      if (existing) {
        // 已存在 → 更新（用最新分析结果覆盖）
        db.getDb().run(`
          UPDATE topic_history SET
            sentiment = ?, heat_score = ?, record_count = ?, topic_tag = ?,
            action_suggestion = ?, is_new_topic = ?, heat_change = ?, trend = ?,
            summary = ?, detail = ?, representative_quotes = ?, urls = ?, created_at = ?
          WHERE id = ?
        `, [
          topic.sentiment || 'neutral', topic.heat || 5, topic.count || 0,
          topic.tag || 'general', topic.action || '', isNew, heatChange, trend,
          topic.summary || '', topic.detail || '',
          JSON.stringify(topic.representative_quotes || []),
          JSON.stringify(topic.urls || []), now, existing.id
        ]);
        updated++;
      } else {
        // 不存在 → 新增
        db.execute(`
          INSERT INTO topic_history 
          (topic_title, platform, sentiment, heat_score, record_count, 
           topic_tag, action_suggestion, is_new_topic, heat_change, trend,
           summary, detail, representative_quotes, urls, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          topic.title, platform,
          topic.sentiment || 'neutral', topic.heat || 5, topic.count || 0,
          topic.tag || 'general', topic.action || '', isNew, heatChange, trend,
          topic.summary || '', topic.detail || '',
          JSON.stringify(topic.representative_quotes || []),
          JSON.stringify(topic.urls || []), now
        ]);
        inserted++;
      }
    });
    
    db.saveDb();
    console.log(`✅ 话题历史: 新增 ${inserted} 个, 更新 ${updated} 个 (${platform})`);
    
  } catch (e) {
    console.error('❌ 保存话题历史失败:', e.message);
  }
}

// ===== 读取今日已分析好的热门话题（只读，不调AI）=====
function getTodayHotTopics() {
  // 直接查今天创建的分析记录（不管具体时间窗口）
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  
  const twitterRows = db.queryAll(`
    SELECT topic_title, sentiment, heat_score, record_count, topic_tag,
           action_suggestion, summary, detail, representative_quotes, urls
    FROM topic_history
    WHERE platform = 'twitter' AND DATE(created_at) = ?
      AND id IN (
        SELECT MAX(id) FROM topic_history
        WHERE platform = 'twitter' AND DATE(created_at) = ?
        GROUP BY topic_tag
      )
    ORDER BY heat_score DESC
  `, [todayStr, todayStr]);
  
  const discordRows = db.queryAll(`
    SELECT topic_title, sentiment, heat_score, record_count, topic_tag,
           action_suggestion, summary, detail, representative_quotes, urls
    FROM topic_history
    WHERE platform = 'discord' AND DATE(created_at) = ?
      AND id IN (
        SELECT MAX(id) FROM topic_history
        WHERE platform = 'discord' AND DATE(created_at) = ?
        GROUP BY topic_tag
      )
    ORDER BY heat_score DESC
  `, [todayStr, todayStr]);
  
  const loungeRows = db.queryAll(`
    SELECT topic_title, sentiment, heat_score, record_count, topic_tag,
           action_suggestion, summary, detail, representative_quotes, urls
    FROM topic_history
    WHERE platform = 'lounge' AND DATE(created_at) = ?
      AND id IN (
        SELECT MAX(id) FROM topic_history
        WHERE platform = 'lounge' AND DATE(created_at) = ?
        GROUP BY topic_tag
      )
    ORDER BY heat_score DESC
  `, [todayStr, todayStr]);

  if (twitterRows.length === 0 && discordRows.length === 0 && loungeRows.length === 0) {
    return null; // 今天还没分析过
  }
  
  const mapRow = r => {
    // ★ tag标准化：使用全局统一函数
    const tag = aiAnalyzer.standardizeTag(r.topic_tag);
    
    return {
      title: r.topic_title,
      summary: r.summary || '',
      detail: r.detail || '',
      heat: r.heat_score || 1,
      sentiment: r.sentiment || 'neutral',
      tag: tag,  // 使用标准化后的tag
      action: r.action_suggestion || '',
      count: r.record_count || 0,
      representative_quotes: safeParseJSON(r.representative_quotes, []),
      urls: safeParseJSON(r.urls, [])
    };
  };
  
  // ★ 读时去重：同 tag 只保留热度最高的（SQL 已按 heat_score DESC 排序，取第一个即可）
  const dedupByTag = (topics) => {
    const seen = new Set();
    return topics.filter(t => {
      if (seen.has(t.tag)) return false;
      seen.add(t.tag);
      return true;
    });
  };
  
  return {
    twitter_topics: dedupByTag(twitterRows.map(mapRow)),
    discord_topics: dedupByTag(discordRows.map(mapRow)),
    lounge_topics: dedupByTag(loungeRows.map(mapRow))
  };
}

/**
 * 清除今天的热门话题分析结果（用于强制重新分析）
 */
function clearTodayTopics() {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  
  db.getDb().run(`DELETE FROM topic_history WHERE DATE(created_at) = ?`, [todayStr]);
  console.log('🧹 已清除今日话题历史');
}

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str || '[]'); } catch (_) { return fallback; }
}

// ===== 主动执行每日热门话题分析（定时任务用）=====
async function runDailyHotTopicsAnalysis() {
  console.log('🔥 开始每日热门话题分析（昨日8:30~今日8:30）');
  
  const { startDate, endDate, periodLabel } = getTodayPeriod();
  console.log(`   周期: ${periodLabel}`);
  
  // 读取这个周期的数据（锁死时间窗口）
  const twitterRecords = getQualityFeedback(30, 'twitter', startDate, endDate);
  const discordRecords = getQualityFeedback(30, 'discord', startDate, endDate);
  const loungeRecords = getLoungeRecordsForAnalysis(startDate, endDate, 30);
  
  const twCount = twitterRecords?.length || 0;
  const dcCount = discordRecords?.length || 0;
  const lgCount = loungeRecords?.length || 0;
  console.log(`   数据: Twitter ${twCount} 条, Discord ${dcCount} 条, 韩国 ${lgCount} 条`);
  
  if (twCount === 0 && dcCount === 0 && lgCount === 0) {
    // 诊断日志：为什么没有数据？
    try {
      const totalInRange = db.queryOne(
        `SELECT COUNT(*) as cnt FROM sentiment_records WHERE created_at >= '${startDate}' AND created_at <= '${endDate}' AND is_noise = 0`
      );
      const totalQuality = db.queryOne(
        `SELECT COUNT(*) as cnt FROM sentiment_records WHERE created_at >= '${startDate}' AND created_at <= '${endDate}' AND is_noise = 0 AND content_quality >= 2`
      );
      console.log(`   📋 诊断: 时间窗口内共 ${totalInRange?.cnt || 0} 条(is_noise=0), 其中 quality≥2 的 ${totalQuality?.cnt || 0} 条`);
      if ((totalInRange?.cnt || 0) > 0 && (totalQuality?.cnt || 0) === 0) {
        console.log('   💡 原因: 有数据但质量分都<2，检查 content_quality 字段');
      } else if ((totalInRange?.cnt || 0) === 0) {
        console.log('   💡 原因: 时间窗口内根本没有数据，检查采集任务是否正常运行');
      }
    } catch (_) {}
    console.log('   ⚠️ 无数据，跳过分析');
    return { success: true, message: '无数据' };
  }
  
  // 调用 AI 分析
  const aiAnalyzer = require('./ai_analyzer');
  const result = await aiAnalyzer.aiSummarizeHotTopicsDual(twitterRecords, discordRecords, loungeRecords);
  
  // 存入 topic_history
  // ★ 关键修复：传入 skipDedup=true，因为 result 已经是 AI 去重后的结果
  if (result.twitter_topics.length > 0) {
    saveTopicHistory(result.twitter_topics, 'twitter', true);
  }
  if (result.discord_topics.length > 0) {
    saveTopicHistory(result.discord_topics, 'discord', true);
  }
  if (result.lounge_topics && result.lounge_topics.length > 0) {
    saveTopicHistory(result.lounge_topics, 'lounge', true);
  }
  
  console.log(`✅ 每日分析完成: Twitter ${result.twitter_topics.length} 个话题, Discord ${result.discord_topics.length} 个话题, 韩国 ${result.lounge_topics?.length || 0} 个话题`);
  if (result.twitter_topics.length === 0 && result.discord_topics.length === 0 && (!result.lounge_topics || result.lounge_topics.length === 0)) {
    console.log('   ⚠️ AI 返回了 0 个话题，可能原因: AI API 超时/返回空结果/解析失败');
  }
  
  // ★ 第三步：AI 哨兵 — 从 general 桶探测新话题
  try {
    const twitterGeneral = twitterRecords.filter(r => r.topic_tag === 'general');
    const discordGeneral = discordRecords.filter(r => r.topic_tag === 'general');
    console.log(`🔍 AI 哨兵: Twitter general ${twitterGeneral.length} 条, Discord general ${discordGeneral.length} 条`);
    
    if (twitterGeneral.length >= 3) {
      const newTwitterTopics = await aiAnalyzer.aiScoutNewTopics(twitterGeneral);
      if (newTwitterTopics.length > 0) {
        // ★ AI 哨兵发现的新话题，也跳过内部去重（因为 scout 已经按 tag 合并了）
        saveTopicHistory(newTwitterTopics, 'twitter', true);
        console.log(`   🆕 Twitter 新话题: ${newTwitterTopics.length} 个`);
      }
    }
    if (discordGeneral.length >= 3) {
      const newDiscordTopics = await aiAnalyzer.aiScoutNewTopics(discordGeneral);
      if (newDiscordTopics.length > 0) {
        // ★ AI 哨兵发现的新话题，也跳过内部去重
        saveTopicHistory(newDiscordTopics, 'discord', true);
        console.log(`   🆕 Discord 新话题: ${newDiscordTopics.length} 个`);
      }
    }
  } catch (e) {
    console.warn(`   ⚠️ AI 哨兵失败（不影响主流程）: ${e.message}`);
  }
  
  return {
    success: true,
    twitter: result.twitter_topics.length,
    discord: result.discord_topics.length,
    lounge: result.lounge_topics?.length || 0
  };
}

// ===== 获取话题趋势数据 =====
function getTopicTrend(platform, days = 7) {
  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = fmtCST8(startDate);
    
    const trends = db.queryAll(`
      SELECT 
        topic_title,
        DATE(created_at) as date,
        AVG(heat_score) as avg_heat,
        COUNT(*) as mention_count,
        GROUP_CONCAT(DISTINCT sentiment) as sentiments
      FROM topic_history
      WHERE platform = '${platform}' AND created_at >= '${startDateStr}'
      GROUP BY topic_title, DATE(created_at)
      ORDER BY date DESC
    `);
    
    // 按话题分组
    const grouped = {};
    trends.forEach(row => {
      if (!grouped[row.topic_title]) {
        grouped[row.topic_title] = {
          title: row.topic_title,
          history: []
        };
      }
      grouped[row.topic_title].history.push({
        date: row.date,
        heat: row.avg_heat,
        count: row.mention_count
      });
    });
    
    return Object.values(grouped);
    
  } catch (e) {
    console.error('❌ 获取话题趋势失败:', e.message);
    return [];
  }
}

// ===== 保存每日舆情快照（只读存档，不重新处理）=====
async function saveDailySnapshot(dateStr = null) {
  try {
    // 如果没有指定日期，使用昨天
    let targetDate;
    if (dateStr) {
      targetDate = new Date(dateStr);
    } else {
      targetDate = new Date();
      targetDate.setDate(targetDate.getDate() - 1); // 默认昨天
    }
    
    const dateKey = fmtCST8(targetDate).substring(0, 10); // YYYY-MM-DD
    
    // 使用 8:30 时间窗口（与一日舆情一致）：dateKey 8:30 ~ dateKey+1天 8:30
    const windowStart = `${dateKey} 08:30:00`;
    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextDateKey = fmtCST8(nextDay).substring(0, 10);
    const windowEnd = `${nextDateKey} 08:30:00`;
    
    console.log(`\n📊 开始保存每日舆情快照: ${dateKey} (窗口: ${windowStart} ~ ${windowEnd})`);
    
    // ★ 核心改动：不再重新查询和过滤数据，而是直接读取已有的 topic_history 和记录数
    // 这样避免重复处理，快照只是“打包存档”已分析好的数据
    
    // 1. 读取该窗口的记录总数（用于统计）
    const countResult = db.queryOne(`
      SELECT COUNT(*) as cnt FROM sentiment_records
      WHERE created_at >= ? AND created_at < ? AND is_noise = 0
    `, [windowStart, windowEnd]);
    const recordCount = countResult?.cnt || 0;
    
    console.log(`    有效记录数: ${recordCount}`);

    // 韩国社区帖子统计
    let loungeCount = 0;
    try {
      const loungeRow = db.queryOne(
        `SELECT COUNT(*) as cnt FROM lounge_posts WHERE crawled_at >= ? AND crawled_at < ?`,
        [windowStart, windowEnd]
      );
      loungeCount = loungeRow?.cnt || 0;
      console.log(`    韩国帖子数: ${loungeCount}`);
    } catch (_) {}
    const totalCount = recordCount + loungeCount;
    
    // 检查是否已存在该日期的快照
    const existing = db.queryOne(
      'SELECT id, ai_topics_json FROM daily_snapshots WHERE snapshot_date = ?',
      [dateKey]
    );
    
    // 保存已有的 AI 分析（防止空结果覆盖已有分析）
    let existingAiTopics = null;
    if (existing) {
      try {
        if (existing.ai_topics_json) {
          const parsed = JSON.parse(existing.ai_topics_json);
          const hasTopics = (parsed.twitter_topics?.length > 0 || parsed.discord_topics?.length > 0);
          if (hasTopics) existingAiTopics = parsed;
        }
      } catch (_) {}
      console.log('   ⚠️ 该日期快照已存在，更新中...');
      // 不再 DELETE，后面用 INSERT OR REPLACE 直接覆盖
    }
    
    // ★ 读取当天已有的 AI 热门话题分析结果（只读取，不重新调用 AI）
    // 使用相同的 8:30 时间窗口
    let aiTopics = { twitter_topics: [], discord_topics: [] };
    try {
      const topicRows = db.queryAll(`
        SELECT topic_title, platform, sentiment, heat_score, record_count,
               topic_tag, action_suggestion, summary, detail, representative_quotes, urls, created_at
        FROM topic_history
        WHERE created_at >= ? AND created_at < ?
          AND id IN (
            SELECT MAX(id) FROM topic_history WHERE created_at >= ? AND created_at < ? GROUP BY topic_tag, platform
          )
        ORDER BY heat_score DESC
      `, [windowStart, windowEnd, windowStart, windowEnd]);
      
      if (topicRows.length > 0) {
        for (const row of topicRows) {
          const topic = {
            title: row.topic_title,
            sentiment: row.sentiment,
            heat: row.heat_score,
            count: row.record_count,
            tag: aiAnalyzer.standardizeTag(row.topic_tag),
            action: row.action_suggestion || '',
            summary: row.summary || '',
            detail: row.detail || '',
            representative_quotes: row.representative_quotes ? JSON.parse(row.representative_quotes) : [],
            urls: row.urls ? JSON.parse(row.urls) : []
          };
          if (row.platform === 'twitter') {
            aiTopics.twitter_topics.push(topic);
          } else {
            aiTopics.discord_topics.push(topic);
          }
        }
        // ★ 去重：同 tag 只保留热度最高的
        const dedupByTag = (arr) => {
          const seen = new Set();
          return arr.filter(t => { if (seen.has(t.tag)) return false; seen.add(t.tag); return true; });
        };
        aiTopics.twitter_topics = dedupByTag(aiTopics.twitter_topics);
        aiTopics.discord_topics = dedupByTag(aiTopics.discord_topics);
        console.log(`   🤖 AI 话题存档: Twitter ${aiTopics.twitter_topics.length} 个, Discord ${aiTopics.discord_topics.length} 个`);
      } else {
        // 如果 topic_history 没数据，但已有快照有 AI 分析，保留旧分析
        if (existingAiTopics) {
          aiTopics = existingAiTopics;
          console.log(`   🤖 topic_history 无数据，保留已有 AI 分析: Twitter ${aiTopics.twitter_topics.length} 个, Discord ${aiTopics.discord_topics.length} 个`);
        } else {
          console.log('   🤖 当天无 AI 分析数据（热门话题可能尚未被访问过）');
        }
      }
    } catch (e) {
      console.warn('   ⚠️ 读取 AI 话题历史失败（可能表还没创建）:', e.message);
    }
    
    const aiTopicsJson = JSON.stringify(aiTopics, null, 2);
    
    // ★ 核心改动：保存快照（只存统计信息和AI话题，不存原始记录JSON）
    // ★ 使用 INSERT OR REPLACE 防止并发问题（snapshot_date 有 UNIQUE 约束）
    const dataJson = JSON.stringify({ lounge_count: loungeCount });
    db.getDb().run(
      'INSERT OR REPLACE INTO daily_snapshots (snapshot_date, data_json, record_count, ai_topics_json) VALUES (?, ?, ?, ?)',
      [dateKey, dataJson, totalCount, aiTopicsJson]
    );
    db.saveDb();
    
    console.log(`✅ 每日舆情快照保存成功: ${dateKey} (${totalCount}条记录, 含韩国${loungeCount}条)`);
    
    return {
      success: true,
      count: totalCount,
      date: dateKey,
      platforms: {
        twitter: aiTopics.twitter_topics.length,
        discord: aiTopics.discord_topics.length
      },
      lounge_count: loungeCount,
      ai_topics: {
        twitter: aiTopics.twitter_topics.length,
        discord: aiTopics.discord_topics.length
      }
    };
    
  } catch (e) {
    console.error('❌ 保存每日舆情快照失败:', e.message);
    return { success: false, error: e.message };
  }
}

// ===== 获取每日舆情快照列表（只读存档，不调AI）=====
function getDailySnapshots(days = 30) {
  try {
    const rows = db.queryAll(`
      SELECT snapshot_date, record_count, ai_topics_json, created_at
      FROM daily_snapshots
      ORDER BY snapshot_date DESC
      LIMIT ?
    `, [days]);
    
    return rows.map(row => {
      let aiTopics = { twitter_topics: [], discord_topics: [] };
      try {
        if (row.ai_topics_json) {
          aiTopics = JSON.parse(row.ai_topics_json);
        }
      } catch (_) {}
      
      return {
        date: row.snapshot_date,
        record_count: row.record_count,
        twitter_topics_count: (aiTopics.twitter_topics || []).length,
        discord_topics_count: (aiTopics.discord_topics || []).length,
        has_ai_analysis: (aiTopics.twitter_topics?.length > 0 || aiTopics.discord_topics?.length > 0),
        created_at: row.created_at
      };
    });
  } catch (e) {
    console.error('❌ 获取每日舆情快照列表失败:', e.message);
    return [];
  }
}

// ===== 获取某天的舆情快照详情（含AI分析结果）=====
function getDailySnapshotDetail(dateKey) {
  try {
    const row = db.queryOne(
      'SELECT * FROM daily_snapshots WHERE snapshot_date = ?',
      [dateKey]
    );
    if (!row) return null;
    
    let aiTopics = { twitter_topics: [], discord_topics: [] };
    try {
      if (row.ai_topics_json) {
        aiTopics = JSON.parse(row.ai_topics_json);
      }
    } catch (_) {}
    
    return {
      date: row.snapshot_date,
      record_count: row.record_count,
      ai_topics: aiTopics,
      created_at: row.created_at
    };
  } catch (e) {
    console.error('❌ 获取舆情快照详情失败:', e.message);
    return null;
  }
}

// ===== 全量采集（用于每日零点重新抓取）=====
async function fullCollectAndSave() {
  console.log('\n🔥 开始全量采集模式...');
  console.log('⏰ 执行时间:', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
  
  try {
    // 1. 全量采集 Twitter（深度滚动50次）
    const twitterData = await collectFromTwitter(true);  // isFullCollect = true
    console.log(`✅ Twitter 全量采集完成: ${twitterData.length} 条`);
    
    // 2. 采集 Discord
    const discordData = await collectFromDiscord();
    console.log(`✅ Discord 采集完成: ${discordData.length} 条`);
    
    // 3. 合并数据
    const allData = [...twitterData, ...discordData];
    console.log(`📦 共采集到 ${allData.length} 条数据，开始保存...`);
    
    // 4. 批量保存（数据库会自动去重，启用 AI 情感分析）
    const result = await batchSaveRecords(allData, true);
    
    console.log('\n✅ 全量采集完成！');
    console.log(`   新增: ${result.saved} 条`);
    console.log(`   跳过(重复): ${result.skipped} 条`);
    console.log(`   失败: ${result.failed} 条`);
    
    return {
      success: true,
      collected: allData.length,
      saved: result.saved,
      skipped: result.skipped,
      failed: result.failed,
      twitter_count: twitterData.length,
      discord_count: discordData.length
    };
  } catch (e) {
    console.error('❌ 全量采集失败:', e.message);
    return { success: false, error: e.message };
  }
}

// ===== 七日概览（逐日数据，给前端趋势图用） =====
function getWeeklyOverview() {
  // 服务器已设 TZ=Asia/Shanghai，直接用本地时间
  const now = new Date();
  const days = [];
  
  // ★ L2530: 只查最近 6 天（去掉当天，因为数据不完整）
  for (let i = 1; i <= 6; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);  // 昨天、前天、...、7天前
    const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const start = dateStr + ' 00:00:00';
    const end = dateStr + ' 23:59:59';
    
    const twCount = db.queryOne(
      `SELECT COUNT(*) as cnt FROM sentiment_records WHERE platform='twitter' AND is_noise=0 AND created_at >= '${start}' AND created_at <= '${end}'`
    );
    const dcCount = db.queryOne(
      `SELECT COUNT(*) as cnt FROM sentiment_records WHERE platform='discord' AND is_noise=0 AND created_at >= '${start}' AND created_at <= '${end}'`
    );
    const sentiments = db.queryAll(
      `SELECT COALESCE(ai_sentiment, sentiment) as sentiment, COUNT(*) as cnt FROM sentiment_records WHERE is_noise=0 AND created_at >= '${start}' AND created_at <= '${end}' GROUP BY COALESCE(ai_sentiment, sentiment)`
    );
    const sMap = { positive: 0, neutral: 0, negative: 0 };
    sentiments.forEach(s => { sMap[s.sentiment] = s.cnt; });

    // 韩国社区（帖子 + 评论，使用实际发布日期）
    let loungeCnt = 0;
    try {
      // ★ L2551: 字符串拼接替代参数化查询
      const lRow = db.queryOne(
        `SELECT COUNT(*) as cnt FROM lounge_posts WHERE post_date = '${dateStr}'`
      );
      const postCnt = lRow?.cnt || 0;
      
      // 评论数（comment_time 是 "YYYY-MM-DD HH:mm:ss" 格式，取前10位再去掉横线比较）
      const datePrefix = dateStr.replace(/-/g, ''); // "2026-07-29" -> "20260729"
      const cRow = db.queryOne(
        `SELECT COUNT(*) as cnt FROM lounge_comments WHERE replace(substr(comment_time, 1, 10), '-', '') = '${datePrefix}'`
      );
      const commentCnt = cRow?.cnt || 0;
      
      loungeCnt = postCnt + commentCnt;
    } catch (_) {}
    
    days.push({
      date: dateStr,
      label: `${d.getMonth()+1}/${d.getDate()}`,
      twitter: twCount.cnt || 0,
      discord: dcCount.cnt || 0,
      lounge: loungeCnt,
      total: (twCount.cnt || 0) + (dcCount.cnt || 0) + loungeCnt,
      sentiment: sMap,
    });
  }
  
  const totalTwitter = days.reduce((s, d) => s + d.twitter, 0);
  const totalDiscord = days.reduce((s, d) => s + d.discord, 0);
  const totalLounge = days.reduce((s, d) => s + (d.lounge || 0), 0);
  const totalAll = totalTwitter + totalDiscord + totalLounge;
  const today = days[days.length - 1];  // ★ L2584: 现在是最末一天（今天的前一天）
  const yesterday = days.length >= 2 ? days[days.length - 2] : null;
  const trendChange = yesterday ? today.total - yesterday.total : 0;
  
  // ★ L2588: 7日时间范围（去掉当天）
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 6);
  const wStart = `${sevenDaysAgo.getFullYear()}-${String(sevenDaysAgo.getMonth()+1).padStart(2,'0')}-${String(sevenDaysAgo.getDate()).padStart(2,'0')} 00:00:00`;
  const yesterdayDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()-1).padStart(2,'0')} 23:59:59`;
  
  // 7日负面舆情统计
  const negCount = db.queryOne(
    `SELECT COUNT(*) as cnt FROM sentiment_records
     WHERE is_noise=0 AND COALESCE(ai_sentiment, sentiment) = 'negative'
     AND created_at >= '${wStart}' AND created_at <= '${yesterdayDate}'`
  );
  const negCnt = negCount?.cnt || 0;
  const negRatio = totalAll > 0 ? Math.round(negCnt / totalAll * 100) : 0;
  
  // ★ L2604: 时间范围标签（昨天~今天的前一天，00:00~23:59）
  const startDate = `${sevenDaysAgo.getFullYear()}-${String(sevenDaysAgo.getMonth()+1).padStart(2,'0')}-${String(sevenDaysAgo.getDate()).padStart(2,'0')}`;
  const endDate = days.length > 0 ? days[days.length - 1].date : '';
  const timeRangeLabel = `${startDate} ~ ${endDate} 00:00~23:59`;
  
  return {
    days,
    total: totalAll,
    totalTwitter,
    totalDiscord,
    totalLounge,
    dailyAvg: Math.round(totalAll / 7),
    trendChange,
    today,
    negCount: negCnt,
    negRatio,
    time_range_label: timeRangeLabel, // ★ L2617: 返回时间范围标签
  };

// ===== 七日热门话题（从 sentiment_records 聚合7日数据 + AI概述） =====
async function getWeeklyHotTopics() {
  // 服务器已设 TZ=Asia/Shanghai，直接用本地时间
  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 6);
  const wStart = `${sevenDaysAgo.getFullYear()}-${String(sevenDaysAgo.getMonth()+1).padStart(2,'0')}-${String(sevenDaysAgo.getDate()).padStart(2,'0')} 00:00:00`;
  const wEnd = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} 23:59:59`;

  const tagLabels = {
    bug_report: 'Bug', gacha: '抽卡', knight_order: '骑士团',
    tree_bond: '树缘', event: '活动', cosmetic: '时装',
    world_boss: '世界Boss', photo: '拍照', pricing: '充值',
    server: '服务器', general: '其他', login: '登录',
    gameplay: '玩法', story: '剧情', collab: '联动',
  };

  // 清洗原声内容：去 hashtag、链接、多余符号，截断到100字
  function cleanVoice(text) {
    if (!text) return '';
    let cleaned = text
      .replace(/https?:\/\/\S+/g, '')           // 去链接
      .replace(/#\S+/g, '')                       // 去 hashtag
      .replace(/@\S+/g, '')                       // 去 @mention
      .replace(/\s+/g, ' ')                       // 多余空格压缩
      .replace(/[\n\r\t]+/g, ' ')                 // 换行压缩
      .replace(/[【】「」《》\[\]{}()（）]/g, '')  // 去括号
      .replace(/[✨🎉🔥💪👍❤️🎮⭐️💎🌟🎯🎁💫✨🌸]/g, '') // 去emoji
      .trim();
    if (cleaned.length > 100) {
      cleaned = cleaned.substring(0, 100) + '...';
    }
    return cleaned;
  }

  async function buildPlatformTopics(platform) {
    // ★ 统一使用 aiSummarizeHotTopics（话题识别 + 总结），与韩服一致
    const records = db.queryAll(
      `SELECT content, translated_content, url, author,
              COALESCE(ai_sentiment, sentiment) as sentiment,
              created_at, topic_tag, content_quality
       FROM sentiment_records
       WHERE platform = ? AND is_noise = 0
       AND created_at >= ? AND created_at <= ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [platform, wStart, wEnd]
    );
    
    if (!records || records.length === 0) return [];
    
    // 为记录添加 source 字段（aiSummarizeHotTopics 需要）
    const recordsWithSource = records.map(r => ({
      ...r,
      source: platform,
    }));
    
    // ★ 调用 AI 进行话题识别 + 总结（与韩服相同）
    let aiTopics;
    try {
      aiTopics = await aiAnalyzer.aiSummarizeHotTopics(recordsWithSource);
    } catch (e) {
      log.warn(`七日话题 AI 分析失败(${platform})`, e.message);
      aiTopics = [];
    }
    
    if (!aiTopics || aiTopics.length === 0) {
      // AI 失败时兑底：按 topic_tag 分组（旧逻辑）
      return buildPlatformTopicsFallback(platform, wStart, wEnd);
    }
    
    // 转换为七日话题展示格式
    const topics = [];
    for (const t of aiTopics) {
      // 原声：优先用 AI 引用的内容，补充数据库记录
      const voiceTexts = [];
      
      // 1. 先用 AI 返回的代表性引用
      if (t.representative_quotes) {
        for (const q of t.representative_quotes) {
          if (q.text) {
            const matched = records.find(r => 
              (r.translated_content || r.content || '').includes(q.text.substring(0, 20))
            );
            voiceTexts.push({
              text: q.text,
              url: matched?.url || '',
              author: matched?.author || '匿名',
              time: matched?.created_at || '',
              type: 'post',
              sentiment: t.sentiment || 'neutral',
            });
          }
        }
      }
      
      // 2. 不够则从记录中补充
      if (voiceTexts.length < 3) {
        for (const r of records) {
          if (voiceTexts.length >= 3) break;
          const text = r.translated_content || r.content || '';
          if (text && !voiceTexts.some(v => v.text === text)) {
            voiceTexts.push({
              text: cleanVoice(text),
              url: r.url || '',
              author: r.author || '匿名',
              time: r.created_at || '',
              type: 'post',
              sentiment: r.sentiment || 'neutral',
            });
          }
        }
      }
      
      topics.push({
        tag: t.tag || 'general',
        title: t.title || tagLabels[t.tag] || t.tag,
        count: t.count || 0,
        heat: t.heat || 1,
        sentiment: t.sentiment || 'neutral',
        neg: 0, pos: 0, neu: 0,
        overview: t.summary || '',
        voices: voiceTexts.slice(0, 3).map(v => ({
          text: v.text || '',
          url: v.url || '',
          author: v.author || '匿名',
          time: v.time ? (v.time.substring(5, 16) || '') : '',
          type: v.type || 'post',
          sentiment: v.sentiment || 'neutral',
        })),
        daily_avg: Math.round((t.count || 0) / 7 * 10) / 10,
      });
    }
    
    return topics;
  }

  // 兑底：按 topic_tag 分组（AI 分析失败时使用）
  function buildPlatformTopicsFallback(platform, wStart, wEnd) {
    const rows = db.queryAll(
      `SELECT topic_tag,
              COUNT(*) as cnt,
              SUM(CASE WHEN COALESCE(ai_sentiment, sentiment) = 'negative' THEN 1 ELSE 0 END) as neg_cnt,
              SUM(CASE WHEN COALESCE(ai_sentiment, sentiment) = 'positive' THEN 1 ELSE 0 END) as pos_cnt,
              SUM(CASE WHEN COALESCE(ai_sentiment, sentiment) = 'neutral' THEN 1 ELSE 0 END) as neu_cnt
       FROM sentiment_records
       WHERE platform = ? AND is_noise = 0
       AND topic_tag IS NOT NULL AND topic_tag != 'general'
       AND created_at >= ? AND created_at <= ?
       GROUP BY topic_tag
       ORDER BY cnt DESC
       LIMIT 8`,
      [platform, wStart, wEnd]
    );
    
    return rows.map(r => {
      const samples = db.queryAll(
        `SELECT content, translated_content, url, author, COALESCE(ai_sentiment, sentiment) as sentiment
         FROM sentiment_records
         WHERE platform = ? AND is_noise = 0 AND topic_tag = ?
         AND created_at >= ? AND created_at <= ?
         ORDER BY content_quality DESC LIMIT 5`,
        [platform, r.topic_tag, wStart, wEnd]
      );
      
      const dominant = r.neg_cnt > r.pos_cnt ? 'negative' : r.pos_cnt > r.neg_cnt ? 'positive' : 'neutral';
      const heat = Math.min(10, Math.max(1, Math.round((r.cnt / 7) * 2) + (dominant === 'negative' ? 2 : 0)));
      
      return {
        tag: r.topic_tag,
        title: tagLabels[r.topic_tag] || r.topic_tag,
        count: r.cnt,
        heat,
        sentiment: dominant,
        neg: r.neg_cnt,
        pos: r.pos_cnt,
        neu: r.neu_cnt || 0,
        overview: `${r.cnt}条关于「${tagLabels[r.topic_tag] || r.topic_tag}」的讨论`,
        voices: samples.slice(0, 3).map(s => ({
          text: cleanVoice(s.translated_content || s.content),
          url: s.url || '',
          author: s.author || '匿名',
          sentiment: s.sentiment || 'neutral',
        })),
        daily_avg: Math.round(r.cnt / 7 * 10) / 10,
      };
    });
  }

  // === 韩国社区七日热门话题 ===
  async function buildLoungeTopics() {
    // 使用 post_date（实际发布日期）而非 crawled_at（抓取时间）
    try {
      // ★ 查询原始帖子（按 post_date 过滤）
      const posts = db.queryAll(
        `SELECT content_zh, title_zh, content, title, author, url, sentiment, crawled_at, post_time, post_id, comment_count, view_count, post_date
         FROM lounge_posts
         WHERE post_date >= ? AND post_date <= ?
         ORDER BY (comment_count + view_count) DESC LIMIT 30`,
        [wStart.split(' ')[0], wEnd.split(' ')[0]]
      );
      if (!posts || posts.length === 0) return [];

      // 构建帖子记录格式（标记 type='post'）
      const records = posts.map(p => {
        const raw = p.content_zh || p.title_zh || p.content || p.title || '';
        return {
          content: cleanLoungeContent(raw),
          translated_content: cleanLoungeContent(p.content_zh || p.title_zh || ''),
          url: p.url || '',
          author: p.author || '',
          sentiment: p.sentiment || 'neutral',
          topic_tag: 'general',
          created_at: p.post_time || p.crawled_at || '',
          type: 'post',
          source: 'lounge',
        };
      });

      // ★ 查询评论数据（标记 type='comment'，按 comment_time 过滤）
      try {
        const datePrefixStart = wStart.split(' ')[0].replace(/-/g, ''); // "2026-07-29" -> "20260729"
        const datePrefixEnd = wEnd.split(' ')[0].replace(/-/g, '');
        const comments = db.queryAll(
          `SELECT c.content_zh, c.content, c.author, c.sentiment, c.crawled_at, c.comment_time, c.likes,
                  p.url as post_url
           FROM lounge_comments c
           LEFT JOIN lounge_posts p ON c.post_id = p.post_id
           WHERE replace(substr(c.comment_time, 1, 10), '-', '') >= ? AND replace(substr(c.comment_time, 1, 10), '-', '') <= ?
             AND c.content IS NOT NULL AND c.content != ''
           ORDER BY c.likes DESC LIMIT 50`,
          [datePrefixStart, datePrefixEnd]
        );
        if (comments && comments.length > 0) {
          for (const c of comments) {
            const raw = c.content_zh || c.content || '';
            records.push({
              content: cleanLoungeContent(raw),
              translated_content: cleanLoungeContent(c.content_zh || ''),
              url: c.post_url || '',
              author: c.author || '匿名',
              sentiment: c.sentiment || 'neutral',
              topic_tag: 'general',
              created_at: c.comment_time || c.crawled_at || '',
              type: 'comment',
              source: 'lounge',
            });
          }
          log.info(`韩国七日话题：合并 ${comments.length} 条评论数据`);
        }
      } catch (e) {
        log.warn('韩国评论数据查询失败', e.message);
      }

      // ★ 使用与 Twitter/Discord 相同的 AI 话题识别
      let aiTopics;
      try {
        aiTopics = await aiAnalyzer.aiSummarizeHotTopics(records);
      } catch (e) {
        log.warn('韩国七日话题 AI 分析失败', e.message);
        aiTopics = [];
      }

      if (!aiTopics || aiTopics.length === 0) {
        // AI 失败时兑底：用 ai_category 分组（旧逻辑）
        return buildLoungeTopicsFallback(wStart.split(' ')[0], wEnd.split(' ')[0]);
      }

      // 转换为七日话题展示格式
      const topics = [];
      for (const t of aiTopics) {
        // 原声：优先用 AI 引用的内容，补充帖子/评论
        const voiceTexts = [];

        // 1. 先用 AI 返回的代表性引用
        if (t.representative_quotes) {
          for (const q of t.representative_quotes) {
            if (q.text) {
              // 尝试从 records 中匹配作者和时间
              const matched = records.find(r => r.content.includes(q.text.substring(0, 20)));
              voiceTexts.push({
                text: q.text,
                url: matched?.url || '',
                author: matched?.author || '匿名',
                time: matched?.created_at || '',
                type: matched?.type || 'post',
                sentiment: t.sentiment || 'neutral',
              });
            }
          }
        }

        // 2. 不够则从帖子中补充
        if (voiceTexts.length < 3) {
          for (const p of posts) {
            if (voiceTexts.length >= 3) break;
            const text = p.content_zh || p.title_zh || '';
            if (text && !voiceTexts.some(v => v.text === text)) {
              voiceTexts.push({
                text: cleanLoungeContent(text).substring(0, 120),
                url: p.url || '',
                author: p.author || '匿名',
                time: p.post_time || p.crawled_at || '',
                type: 'post',
                sentiment: p.sentiment || 'neutral',
              });
            }
          }
        }

        topics.push({
          tag: t.tag || 'general',
          title: t.title || tagLabels[t.tag] || t.tag,
          count: t.count || 0,
          heat: t.heat || 1,
          sentiment: t.sentiment || 'neutral',
          neg: 0, pos: 0, neu: 0,
          overview: t.summary || '',
          voices: voiceTexts.slice(0, 3).map(v => ({
            text: v.text || '',
            url: v.url || '',
            author: v.author || '匿名',
            time: v.time ? (v.time.substring(5, 16) || '') : '',
            type: v.type || 'post',
            sentiment: v.sentiment || 'neutral',
          })),
          daily_avg: Math.round((t.count || 0) / 7 * 10) / 10,
        });
      }

      return topics;
    } catch (e) {
      log.warn('韩国七日话题统计失败', e.message);
      return [];
    }
  }

  // 兑底：按 ai_category 分组（AI 分析失败时使用）
  function buildLoungeTopicsFallback(startDate, endDate) {
    const catLabels = {
      bug: 'Bug反馈', suggestion: '建议反馈', complaint: '玩家投诉',
      praise: '好评反馈', question: '玩家提问', other: '其他讨论',
    };
    try {
      const rows = db.queryAll(
        `SELECT ai_category, COUNT(*) as cnt,
                SUM(CASE WHEN sentiment = 'negative' THEN 1 ELSE 0 END) as neg_cnt,
                SUM(CASE WHEN sentiment = 'positive' THEN 1 ELSE 0 END) as pos_cnt,
                SUM(CASE WHEN sentiment = 'neutral' THEN 1 ELSE 0 END) as neu_cnt
         FROM lounge_posts
         WHERE ai_category IS NOT NULL AND ai_category != 'other'
         AND post_date >= ? AND post_date <= ?
         GROUP BY ai_category ORDER BY cnt DESC LIMIT 8`,
        [startDate, endDate]
      );
      return rows.map(r => {
        const samples = db.queryAll(
          `SELECT content_zh, title_zh, content, title, author, url, sentiment
           FROM lounge_posts WHERE ai_category = ?
           AND post_date >= ? AND post_date <= ? ORDER BY comment_count DESC LIMIT 5`,
          [r.ai_category, startDate, endDate]
        );
        const dominant = r.neg_cnt > r.pos_cnt ? 'negative' : r.pos_cnt > r.neg_cnt ? 'positive' : 'neutral';
        const heat = Math.min(10, Math.max(1, Math.round((r.cnt / 7) * 2) + (dominant === 'negative' ? 2 : 0)));
        return {
          tag: r.ai_category, title: catLabels[r.ai_category] || r.ai_category,
          count: r.cnt, heat, sentiment: dominant,
          neg: r.neg_cnt, pos: r.pos_cnt, neu: r.neu_cnt || 0,
          overview: `${r.cnt}条关于「${catLabels[r.ai_category] || r.ai_category}」的讨论`,
          voices: samples.slice(0, 3).map(s => ({
            text: s.content_zh || s.title_zh || s.content || s.title || '',
            url: s.url || '', author: s.author || '匿名', sentiment: s.sentiment || 'neutral',
          })),
          daily_avg: Math.round(r.cnt / 7 * 10) / 10,
        };
      });
    } catch (e) {
      log.warn('韩国七日话题兜底也失败', e.message);
      return [];
    }
  }

  const [twitterTopics, discordTopics, loungeTopics] = await Promise.all([
    buildPlatformTopics('twitter'),
    buildPlatformTopics('discord'),
    buildLoungeTopics(),
  ]);

  return {
    twitter_topics: twitterTopics,
    discord_topics: discordTopics,
    lounge_topics: loungeTopics,
  };
}

// ===== 每日舆情概述（AI 话题识别 + 总结，与七日热门话题统一） =====
async function getDailyOverview() {
  const { startDate, endDate } = getTodayPeriod();
  
  async function buildPlatformOverview(platform) {
    const records = db.queryAll(
      `SELECT content, translated_content, url, author,
              COALESCE(ai_sentiment, sentiment) as sentiment,
              created_at, content_quality
       FROM sentiment_records
       WHERE platform = '${platform}' AND is_noise = 0 AND created_at >= '${startDate}' AND created_at <= '${endDate}'
       ORDER BY content_quality DESC
       LIMIT 30`
    );
    
    if (!records || records.length === 0) {
      return { hasData: false, text: '今日暂无玩家发言', topics: [], samples: [] };
    }
    
    // 清洗原声
    function cleanVoice(text) {
      if (!text) return '';
      let cleaned = text
        .replace(/https?:\/\/\S+/g, '')
        .replace(/#\S+/g, '')
        .replace(/@\S+/g, '')
        .replace(/\s+/g, ' ')
        .replace(/[\n\r\t]+/g, ' ')
        .replace(/[【】「」《》\[\]{}()（）]/g, '')
        .trim();
      if (cleaned.length > 100) cleaned = cleaned.substring(0, 100) + '...';
      return cleaned;
    }
    
    // ★ 调用 AI 进行话题识别 + 总结（与七日热门话题统一）
    const recordsWithSource = records.map(r => ({ ...r, source: platform }));
    let aiTopics;
    try {
      aiTopics = await aiAnalyzer.aiSummarizeHotTopics(recordsWithSource);
    } catch (e) {
      log.warn(`每日概述 AI 分析失败(${platform})`, e.message);
      aiTopics = [];
    }
    
    // 统计情绪分布
    const pos = records.filter(r => r.sentiment === 'positive').length;
    const neg = records.filter(r => r.sentiment === 'negative').length;
    const neu = records.filter(r => r.sentiment === 'neutral').length;
    
    // 转换为展示格式
    const topics = [];
    if (aiTopics && aiTopics.length > 0) {
      for (const t of aiTopics) {
        const voiceTexts = [];
        if (t.representative_quotes) {
          for (const q of t.representative_quotes) {
            if (q.text) {
              const matched = records.find(r => 
                (r.translated_content || r.content || '').includes(q.text.substring(0, 20))
              );
              voiceTexts.push({
                text: q.text,
                url: matched?.url || '',
                author: matched?.author || '匿名',
                time: matched?.created_at || '',
                type: 'post',
                sentiment: t.sentiment || 'neutral',
              });
            }
          }
        }
        if (voiceTexts.length < 2) {
          for (const r of records) {
            if (voiceTexts.length >= 2) break;
            const text = r.translated_content || r.content || '';
            if (text && !voiceTexts.some(v => v.text === text)) {
              voiceTexts.push({
                text: cleanVoice(text),
                url: r.url || '',
                author: r.author || '匿名',
                time: r.created_at || '',
                type: 'post',
                sentiment: r.sentiment || 'neutral',
              });
            }
          }
        }
        topics.push({
          tag: t.tag || 'general',
          title: t.title || t.tag,
          count: t.count || 0,
          heat: t.heat || 1,
          sentiment: t.sentiment || 'neutral',
          overview: t.summary || '',
          voices: voiceTexts.slice(0, 2).map(v => ({
            text: v.text || '',
            url: v.url || '',
            author: v.author || '匿名',
            time: v.time ? (v.time.substring(5, 16) || '') : '',
            type: v.type || 'post',
            sentiment: v.sentiment || 'neutral',
          })),
        });
      }
    }
    
    // 取3条代表性原声
    const samples = records.slice(0, 3).map(r => ({
      text: cleanVoice(r.translated_content || r.content),
      url: r.url || '',
      author: r.author || '匿名',
      sentiment: r.sentiment || 'neutral',
    }));
    
    // 生成概述文本（用于 fallback 显示）
    const total = records.length;
    let moodText = '情绪平稳';
    if (neg > pos && neg > neu) moodText = '负面情绪偏多';
    else if (pos > neg && pos > neu) moodText = '正面情绪为主';
    else if (neu >= pos && neu >= neg) moodText = '以中性讨论为主';
    
    const text = topics.length > 0 
      ? `共${total}条发言，${moodText}，发现${topics.length}个话题`
      : `总共发言${total}条，${moodText}`;
    
    return { hasData: true, text, topics, samples, total, pos, neg, neu };
  }
  
  async function buildLoungeOverview() {
    // 服务器已设 TZ=Asia/Shanghai，直接用本地时间
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    try {
      // ★ L3149: 字符串拼接替代参数化查询
      const posts = db.queryAll(
        `SELECT title_zh, title, content_zh, content, author, url, sentiment, crawled_at, post_time, post_date, comment_count, view_count
         FROM lounge_posts
         WHERE post_date = '${today}'
         ORDER BY (comment_count + view_count) DESC LIMIT 20`
      );
      // 同时查询评论数据
      const datePrefix = today.replace(/-/g, '');
      // ★ L3161: 字符串拼接替代参数化查询
      const comments = db.queryAll(
        `SELECT c.author, c.sentiment, c.content_zh, c.content, c.likes, c.comment_time,
                p.url as post_url
         FROM lounge_comments c
         LEFT JOIN lounge_posts p ON c.post_id = p.post_id
         WHERE replace(substr(c.comment_time, 1, 10), '-', '') = '${datePrefix}'
           AND c.content IS NOT NULL AND c.content != ''
         ORDER BY c.likes DESC LIMIT 20`
      ) || [];

      const allRecords = [
        ...(posts || []).map(p => ({
          content: cleanLoungeContent(p.content_zh || p.title_zh || p.content || p.title || ''),
          translated_content: cleanLoungeContent(p.content_zh || ''),
          url: p.url || '',
          author: p.author || '匿名',
          sentiment: p.sentiment || 'neutral',
          created_at: p.crawled_at || '',
          type: 'post',
          source: 'lounge',
        })),
        ...comments.map(c => ({
          content: cleanLoungeContent(c.content_zh || c.content || ''),
          translated_content: cleanLoungeContent(c.content_zh || ''),
          url: c.post_url || '',
          author: c.author || '匿名',
          sentiment: c.sentiment || 'neutral',
          created_at: c.comment_time || c.crawled_at || '',
          type: 'comment',
          source: 'lounge',
        })),
      ];

      if (allRecords.length === 0) {
        return { hasData: false, text: '今日暂无韩国社区发言', topics: [], samples: [] };
      }
      
      // ★ 调用 AI 进行话题识别 + 总结
      let aiTopics;
      try {
        aiTopics = await aiAnalyzer.aiSummarizeHotTopics(allRecords);
      } catch (e) {
        log.warn('韩国每日概述 AI 分析失败', e.message);
        aiTopics = [];
      }
      
      const pos = allRecords.filter(r => r.sentiment === 'positive').length;
      const neg = allRecords.filter(r => r.sentiment === 'negative').length;
      const neu = allRecords.filter(r => r.sentiment === 'neutral').length;
      
      // 转换为展示格式
      const topics = [];
      if (aiTopics && aiTopics.length > 0) {
        for (const t of aiTopics) {
          const voiceTexts = [];
          if (t.representative_quotes) {
            for (const q of t.representative_quotes) {
              if (q.text) {
                const matched = allRecords.find(r => 
                  (r.translated_content || r.content || '').includes(q.text.substring(0, 20))
                );
                voiceTexts.push({
                  text: q.text,
                  url: matched?.url || '',
                  author: matched?.author || '匿名',
                  time: matched?.created_at || '',
                  type: matched?.type || 'post',
                  sentiment: t.sentiment || 'neutral',
                });
              }
            }
          }
          if (voiceTexts.length < 2) {
            for (const r of allRecords) {
              if (voiceTexts.length >= 2) break;
              const text = r.translated_content || r.content || '';
              if (text && !voiceTexts.some(v => v.text === text)) {
                voiceTexts.push({
                  text: cleanLoungeContent(text).substring(0, 120),
                  url: r.url || '',
                  author: r.author || '匿名',
                  time: r.created_at || '',
                  type: r.type || 'post',
                  sentiment: r.sentiment || 'neutral',
                });
              }
            }
          }
          topics.push({
            tag: t.tag || 'general',
            title: t.title || t.tag,
            count: t.count || 0,
            heat: t.heat || 1,
            sentiment: t.sentiment || 'neutral',
            overview: t.summary || '',
            voices: voiceTexts.slice(0, 2).map(v => ({
              text: v.text || '',
              url: v.url || '',
              author: v.author || '匿名',
              time: v.time ? (v.time.substring(5, 16) || '') : '',
              type: v.type || 'post',
              sentiment: v.sentiment || 'neutral',
            })),
          });
        }
      }
      
      const total = allRecords.length;
      let moodText = '情绪平稳';
      if (neg > pos && neg > neu) moodText = '负面情绪偏多';
      else if (pos > neg && pos > neu) moodText = '正面情绪为主';
      else if (neu >= pos && neu >= neg) moodText = '以中性讨论为主';
      
      const postCount = posts ? posts.length : 0;
      const commentCount = comments.length;
      const text = topics.length > 0
        ? `帖子${postCount}条、评论${commentCount}条，${moodText}，发现${topics.length}个话题`
        : `帖子${postCount}条、评论${commentCount}条，${moodText}`;
      
      const samples = allRecords.slice(0, 3).map(p => ({
        text: cleanLoungeContent(p.content).substring(0, 200),
        url: p.url || '',
        author: p.author || '匿名',
        sentiment: p.sentiment || 'neutral',
      }));
      
      return { hasData: true, text, topics, samples, total, pos, neg, neu };
    } catch (e) {
      return { hasData: false, text: '今日暂无韩国社区发言', topics: [], samples: [] };
    }
  }

  const [twitter, discord, lounge] = await Promise.all([
    buildPlatformOverview('twitter'),
    buildPlatformOverview('discord'),
    buildLoungeOverview(),
  ]);

  return { twitter, discord, lounge };
}

// ===== 导出 API =====
module.exports = {
  initSentimentTable,
  initWeeklyReportsTable,
  initTopicHistoryTable,   // 新增：话题历史表初始化
  collectFromTwitter,
  collectFromDiscord,
  fullCollectAndSave,      // 全量采集（每日零点执行）
  batchSaveRecords,
  getStatistics,
  getRecentFeedback,
  getTodayPeriod,            // 获取今日时间窗口（前日8:30~今日8:30）
  getQualityFeedback,        // 高质量反馈（用于 AI 分析）
  getLoungeRecordsForAnalysis, // 韩国社区数据查询（用于 AI 分析）
  getDailySentiment,         // 一日内舆情
  getRealtimeFeedback,       // 实时玩家发言
  markAsProcessed,
  analyzeSentiment,
  extractKeywords,
  getIsCollecting,           // 获取采集锁状态
  setIsCollecting,           // 设置采集锁状态
  classifyContent,
  isMessageValuable,         // 噪音过滤
  scoreContentQuality,       // 质量评分
  classifyGameTopic,         // 游戏话题分类
  backfillExistingRecords,   // 回溯标记历史数据
  backfillAISentiment,         // 回填 AI 情感分析
  deduplicateHistoricalData, // 历史数据去重
  saveTopicHistory,          // 保存话题历史
  getTodayHotTopics,         // 读取今日已分析好的热门话题
  clearTodayTopics,          // 清除今日话题历史（用于强制重新分析）
  runDailyHotTopicsAnalysis, // 主动执行每日热门话题分析
  getTopicTrend,             // 获取话题趋势
  getSentimentTrendAnalysis, // 获取情绪倾向分析（新增）
  saveDailySnapshot,         // 保存每日舆情快照
  getDailySnapshots,           // 获取快照列表
  getDailySnapshotDetail,      // 获取快照详情
  getSystemErrors,             // 获取系统错误日志（状态面板用）
  getCollectionStatus,         // 获取采集状态（状态面板用）
  recordError,                 // 记录错误（其他模块也可用）
  normalizeDateTime,           // 时间格式统一规范化
  getWeeklyOverview,           // 七日概览（逐日数据）
  getWeeklyHotTopics,          // 七日热门话题（聚合7日数据）
  getDailyOverview,            // 每日舆情概述（无话题时的兆底）
  filterOfficialRecords,       // 官方/运营发言过滤
  deduplicateRecords,          // 内存去重
  getAnalysisSnapshot,         // 获取上次分析时的快照
  setAnalysisSnapshot,         // 更新分析快照
  getCurrentDataSnapshot,      // 获取当前数据快照
};
