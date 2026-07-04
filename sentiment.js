/**
 * M2G 用户运营后台 - 舆情监控模块
 * 负责采集、分析和展示各平台的玩家反馈
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { CHANNELS, getDiscordToken, getProxyConfig } = require('./config');
const db = require('./db');
const log = require('./logger');
const translator = require('./translator');
const aiAnalyzer = require('./ai_analyzer');
const { fetchMessages, nowCst, formatCst } = require('./scanner');

// ===== 全局采集锁（防止并发冲突）=====
let isCollecting = false;

// 采集锁操作封装
function getIsCollecting() { return isCollecting; }
function setIsCollecting(val) { isCollecting = val; }

// 本地时间格式化（避免 toISOString 的 UTC 偏移）
function fmtLocalDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'),
        day = String(d.getDate()).padStart(2,'0'), h = String(d.getHours()).padStart(2,'0'),
        min = String(d.getMinutes()).padStart(2,'0'), sec = String(d.getSeconds()).padStart(2,'0');
  return `${y}-${m}-${day} ${h}:${min}:${sec}`;
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
    } catch (_) {}
    
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
  // 直接使用本地时间（Windows系统已是 CST）
  const now = new Date();
  
  // 今天的 8:30
  const today830am = new Date(now);
  today830am.setHours(8, 30, 0, 0);
  
  // 如果当前时间在 8:30 之前，则“今天”的8:30实际上是昨天的
  if (now < today830am) {
    today830am.setDate(today830am.getDate() - 1);
  }
  
  // 昨天的 8:30
  const yesterday830am = new Date(today830am);
  yesterday830am.setDate(today830am.getDate() - 1);
  
  // 格式化为数据库字符串格式 "YYYY-MM-DD HH:mm:ss"
  const formatDate = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  };
  
  return {
    startDate: formatDate(yesterday830am),
    endDate: formatDate(today830am),
    periodLabel: `${yesterday830am.getFullYear()}/${yesterday830am.getMonth()+1}/${yesterday830am.getDate()} 8:30 ~ ${today830am.getFullYear()}/${today830am.getMonth()+1}/${today830am.getDate()} 8:30`
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

// ===== 获取高质量反馈（用于 AI 分析）=====
function getQualityFeedback(limit = 30, platform = null, startDate = null, endDate = null) {
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
  
  // 优先取 quality >= 2
  conditions.push('content_quality >= 2');
  
  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  params.push(limit);
  
  let rows = db.queryAll(`
    SELECT * FROM sentiment_records 
    ${whereClause}
    ORDER BY content_quality DESC, created_at DESC 
    LIMIT ?
  `, params);
  
  // 不足 10 条时降级取 quality >= 1（保留时间过滤）
  if (rows.length < 10) {
    const fallbackConditions = ['is_noise = 0', 'content_quality >= 1'];
    const fallbackParams = [];
    if (platform) {
      fallbackConditions.push('platform = ?');
      fallbackParams.push(platform);
    }
    if (startDate) {
      fallbackConditions.push('created_at >= ?');
      fallbackParams.push(startDate);
    }
    if (endDate) {
      fallbackConditions.push('created_at <= ?');
      fallbackParams.push(endDate);
    }
    fallbackParams.push(limit);
    
    rows = db.queryAll(`
      SELECT * FROM sentiment_records 
      WHERE ${fallbackConditions.join(' AND ')}
      ORDER BY content_quality DESC, created_at DESC 
      LIMIT ?
    `, fallbackParams);
  }
  
  return rows.map(row => ({
    ...row,
    keywords: row.keywords ? row.keywords.split(',') : []
  }));
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
  return fmtLocalDate(new Date());
}

// ===== Twitter 数据采集（日服）=====
// ===== Twitter 采集（Yahoo 实时搜索 API）=====
// 完全基于 Python 脚本 yahoo_scraper_v4.py 重写
async function collectFromTwitter(isFullCollect = false) {
  console.log('🐦 开始从 Twitter 采集数据...');
  
  const keywords = ['ツリネバ', 'TOSN', 'TOSNeverland'];
  const searchQuery = keywords.join(' OR ');
  
  try {
    return await collectFromYahooApi(searchQuery, isFullCollect);
  } catch (error) {
    console.error('❌ Twitter 采集失败:', error.message);
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
  const proxyConfig = getProxyConfig();
  
  const axiosInstance = axios.create({
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8'
    },
    proxy: proxyConfig
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
    
    const $ = cheerio.load(response.data);
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
      const content = entry.displayText || entry.displayTextBody || '';
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
      const today = fmtLocalDate(new Date()).substring(0, 10);
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

// ===== Discord 数据采集（仅繁中服）=====
async function collectFromDiscord() {
  console.log('💬 开始从 Discord 采集数据...');
  
  // 繁中服 Discord 频道配置
  const tcChannels = [
    { id: '1236867556355346484', name: '💬日常閒聊' },
    { id: '1320748853732970556', name: '👂八卦吃瓜' }
  ];
  
  // 用于去重的 Map：key = author + contentHash, value = { channels: [], firstMessage }
  const messageMap = new Map();
  
  console.log(`\n   正在采集 TC（繁中服）Discord 数据...`);
  
  for (const channel of tcChannels) {
    try {
      console.log(`     📡 频道: ${channel.name}`);
      
      // 使用繁中服 Bot Token，增加采集数量以获取最新消息
      const messages = await fetchMessages(channel.id, 'TC', 200); // 从100增加到200
      
      if (Array.isArray(messages)) {
        console.log(`        ✅ 获取到 ${messages.length} 条原始消息`);
        
        let validCount = 0;
        for (const msg of messages) {
          const content = msg.content || '';
          
          // 跳过空消息和 Bot 消息
          if (!content.trim() || msg.author?.bot) {
            continue;
          }
          
          validCount++;
          
          // 生成作者+内容的唯一标识（用于去重）
          const author = msg.author?.global_name || msg.author?.username || '未知用户';
          const crypto = require('crypto');
          // 只取前100个字符进行哈希比较，避免过长内容影响性能
          const contentPreview = content.substring(0, 100);
          const contentHash = crypto.createHash('md5').update(contentPreview).digest('hex').substring(0, 16);
          const uniqueKey = `${author}_${contentHash}`;
          
          if (messageMap.has(uniqueKey)) {
            // 已存在相同内容，添加频道标记
            const existing = messageMap.get(uniqueKey);
            if (!existing.channels.includes(channel.name)) {
              existing.channels.push(channel.name);
            }
            // 保留最早的 timestamp 和对应的 source_id
            if (msg.timestamp && (!existing.firstMessage.timestamp || msg.timestamp < existing.firstMessage.timestamp)) {
              existing.firstMessage.timestamp = msg.timestamp;
              existing.firstMessage.source_id = msg.id;
            }
          } else {
            // 新消息，创建记录
            // Discord的timestamp是ISO格式，需要转换为CST时间字符串
            let cstTimeStr;
            try {
              const discordTime = new Date(msg.timestamp);
              // Discord返回的是UTC时间，需要+8小时转换为CST
              cstTimeStr = formatCst(discordTime);
            } catch (e) {
              // 如果解析失败，使用当前CST时间
              cstTimeStr = formatCst(nowCst());
            }
            
            messageMap.set(uniqueKey, {
              channels: [channel.name],
              firstMessage: {
                platform: 'discord',
                source_id: msg.id,
                content: content,
                author: author,
                timestamp: cstTimeStr, // 使用CST时间字符串
                region: 'tc'
              }
            });
          }
        }
        
        console.log(`         有效消息: ${validCount} 条`);
      } else {
        console.log(`        ⚠️  返回数据格式异常`);
      }
    } catch (e) {
      console.error(`        ❌ 获取频道 ${channel.name} 失败: ${e.message}`);
    }
  }
  
  // 转换为最终结果，合并频道标记
  const collected = Array.from(messageMap.values()).map(item => ({
    ...item.firstMessage,
    channel_name: item.channels.join(', ')  // 多个频道用逗号分隔
  }));
  
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
  const isNoise = valuable ? 0 : 1;
  const contentQuality = scoreContentQuality(record.content, record.platform);
  const topicTag = classifyGameTopic(record.content);
  
  // 计算优先级
  let priority = 0;
  if (sentiment === 'negative') priority += 2;
  if (category === 'bug') priority += 2;
  if (category === 'complaint') priority += 1;
  if (keywords.some(k => ['BUG', '崩溃', '无法登录'].includes(k))) priority += 1;
  
  // 只要包含日文字符就翻译（Twitter 日服、Discord 日服等）
  let translatedContent = null;
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
  let aiSentiment = null;
  let aiConfidence = null;
  let aiReason = null;
  let aiCategory = null;
  
  if (enableAI) {
    try {
      // 根据实际内容语言而非平台判断
      const contentLang = translator.hasJapaneseCharacters(record.content) ? 'ja' : 'zh';
      const aiResult = await aiAnalyzer.aiAnalyzeSentiment(
        record.content,
        contentLang
      );
      aiSentiment = aiResult.sentiment;
      aiConfidence = aiResult.confidence;
      aiReason = aiResult.reason;
      
      const aiCat = await aiAnalyzer.aiClassifyFeedback(record.content);
      aiCategory = aiCat;
    } catch (e) {
      console.warn('⚠️ AI 分析失败，跳过:', e.message);
    }
  }
  
  const sql = `
    INSERT INTO sentiment_records 
    (platform, source_id, content, translated_content, author, channel_name, 
     sentiment, ai_sentiment, ai_confidence, ai_reason, ai_category, 
     keywords, category, priority, created_at, is_noise, content_quality, topic_tag,
     time_text, url, has_media)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  
  // 处理时间字段：优先使用record中的created_at或timestamp（已经是CST格式），否则使用当前CST时间
  let createdAt;
  const timeValue = record.created_at || record.timestamp;  // 支持两种字段名
  
  if (timeValue) {
    // 如果timeValue已经是CST格式字符串（YYYY-MM-DD HH:MM:SS），直接使用
    if (typeof timeValue === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timeValue)) {
      createdAt = timeValue;
    } else {
      // 如果是其他格式，尝试转换
      try {
        const dateObj = new Date(timeValue);
        createdAt = formatCst(dateObj);
      } catch (e) {
        createdAt = formatCst(nowCst());
      }
    }
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
    record.has_media ? 1 : 0   // 是否带图/视频
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
    
    // 检查是否已存在（避免重复）
    const existing = db.queryOne(
      'SELECT id FROM sentiment_records WHERE platform = ? AND source_id = ?',
      [record.platform, record.source_id]
    );
    
    if (existing) {
      console.log(`   ⏸️  跳过重复: source_id=${record.source_id}, 作者=${record.author}`);
      skipped++;
      continue; // 跳过已存在的记录
    }
    
    // 只对前 maxAIRecords 条启用 AI 分析
    const useAI = enableAI && i < maxAIRecords;
    
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
  const now = new Date(); // 直接使用本地时间(CST)
  
  let startDate, endDate, periodLabel;
  
  if (period === 'today') {
    // 舆情监控面板：前一日 8:30 到 今日 8:30
    const { startDate: s, endDate: e, periodLabel: label } = getTodayPeriod();
    startDate = s;
    endDate = e;
    periodLabel = label;
  } else {
    // 周报：上周一 00:00 到 上周日 23:59
    const daysSinceMonday = (now.getDay() + 6) % 7; // 距离上周一的天数
    
    // 上周一 00:00
    const startOfLastMonday = new Date(now);
    startOfLastMonday.setDate(now.getDate() - daysSinceMonday - 7);
    startOfLastMonday.setHours(0, 0, 0, 0);
    
    // 上周日 23:59:59
    const endOfLastSunday = new Date(startOfLastMonday);
    endOfLastSunday.setDate(startOfLastMonday.getDate() + 6);
    endOfLastSunday.setHours(23, 59, 59, 999);
    
    const fmtLocal = fmtLocalDate;
    startDate = fmtLocal(startOfLastMonday);
    endDate = fmtLocal(endOfLastSunday);
    periodLabel = `${startOfLastMonday.toLocaleDateString('zh-CN')} ~ ${endOfLastSunday.toLocaleDateString('zh-CN')}`;
  }
  
  console.log(`📅 统计周期: ${periodLabel}`);
  
  // Twitter 数据统计（AI 情感优先，规则情感兆底，过滤噪音）
  const twitterCount = db.queryOne(
    `SELECT COUNT(*) as cnt FROM sentiment_records 
     WHERE platform = 'twitter' AND is_noise = 0
     AND created_at >= ? AND created_at <= ?`,
    [startDate, endDate]
  );
  
  const twitterSentiment = db.queryAll(
    `SELECT COALESCE(ai_sentiment, sentiment) as sentiment, COUNT(*) as cnt FROM sentiment_records 
     WHERE platform = 'twitter' AND is_noise = 0
     AND created_at >= ? AND created_at <= ?
     GROUP BY COALESCE(ai_sentiment, sentiment)`,
    [startDate, endDate]
  );
  
  // Discord 数据统计（AI 情感优先，规则情感兆底，过滤噪音）
  const discordCount = db.queryOne(
    `SELECT COUNT(*) as cnt FROM sentiment_records 
     WHERE platform = 'discord' AND is_noise = 0
     AND created_at >= ? AND created_at <= ?`,
    [startDate, endDate]
  );
  
  const discordSentiment = db.queryAll(
    `SELECT COALESCE(ai_sentiment, sentiment) as sentiment, COUNT(*) as cnt FROM sentiment_records 
     WHERE platform = 'discord' AND is_noise = 0
     AND created_at >= ? AND created_at <= ?
     GROUP BY COALESCE(ai_sentiment, sentiment)`,
    [startDate, endDate]
  );
  
  // 按区域统计（过滤噪音）
  const regionStats = db.queryAll(
    `SELECT region, COUNT(*) as cnt FROM sentiment_records 
     WHERE is_noise = 0
     AND created_at >= ? AND created_at <= ?
     AND region IS NOT NULL
     GROUP BY region
     ORDER BY cnt DESC`,
    [startDate, endDate]
  );
  
  // 提取热门话题（按关键词分组）
  const twitterTopics = db.queryAll(
    `SELECT keywords, COUNT(*) as cnt FROM sentiment_records 
     WHERE platform = 'twitter' 
     AND created_at >= ? AND created_at <= ?
     AND keywords != ''
     GROUP BY keywords
     ORDER BY cnt DESC
     LIMIT 8`,
    [startDate, endDate]
  );
  
  const discordTopics = db.queryAll(
    `SELECT keywords, COUNT(*) as cnt FROM sentiment_records 
     WHERE platform = 'discord' 
     AND created_at >= ? AND created_at <= ?
     AND keywords != ''
     GROUP BY keywords
     ORDER BY cnt DESC
     LIMIT 8`,
    [startDate, endDate]
  );
  
  // 计算风险等级（Twitter + Discord 综合负面比例）
  const twNeg = twitterSentiment.find(r => r.sentiment === 'negative')?.cnt || 0;
  const twTotal = twitterCount?.cnt || 0;
  const dcNeg = discordSentiment.find(r => r.sentiment === 'negative')?.cnt || 0;
  const dcTotal = discordCount?.cnt || 0;
  const totalNeg = twNeg + dcNeg;
  const totalCount = twTotal + dcTotal;
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
    twitter_topics: twitterTopics.map(r => ({
      name: r.keywords.split(',')[0] || '其他',
      count: r.cnt
    })),
    discord_topics: discordTopics.map(r => ({
      name: r.keywords.split(',')[0] || '其他',
      count: r.cnt
    }))
  };
}

// ===== 获取最新反馈列表 =====
function getRecentFeedback(limit = 50, filters = {}) {
  const conditions = [];
  const params = [];
  
  if (filters.platform) {
    conditions.push('platform = ?');
    params.push(filters.platform);
  }
  
  if (filters.sentiment) {
    conditions.push('sentiment = ?');
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
  
  const conditions = ['created_at >= ?', 'created_at <= ?', 'is_noise = 0'];
  const params = [startDate, endDate];
  
  if (platform) {
    conditions.push('platform = ?');
    params.push(platform);
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
    WHERE ${conditions.join(' AND ')}
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
  const now = new Date(); // 直接使用本地时间(CST)
  const startDate = new Date(now);
  startDate.setDate(now.getDate() - days);
  startDate.setHours(0, 0, 0, 0);
  
  const startStr = fmtLocalDate(startDate);
  
  // 基础统计
  const baseConditions = platform ? ['platform = ?'] : [];
  const baseParams = platform ? [platform] : [];
  baseParams.push(startStr);
  
  const totalStats = db.queryOne(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN COALESCE(ai_sentiment, sentiment) = 'positive' THEN 1 ELSE 0 END) as positive,
            SUM(CASE WHEN COALESCE(ai_sentiment, sentiment) = 'negative' THEN 1 ELSE 0 END) as negative,
            SUM(CASE WHEN COALESCE(ai_sentiment, sentiment) = 'neutral' THEN 1 ELSE 0 END) as neutral
     FROM sentiment_records 
     WHERE is_noise = 0 AND created_at >= ? ${platform ? 'AND platform = ?' : ''}`,
    [...baseParams]
  );
  
  // 按天统计趋势
  const dailyTrend = db.queryAll(
    `SELECT DATE(created_at) as date,
            COUNT(*) as count,
            SUM(CASE WHEN COALESCE(ai_sentiment, sentiment) = 'positive' THEN 1 ELSE 0 END) as positive,
            SUM(CASE WHEN COALESCE(ai_sentiment, sentiment) = 'negative' THEN 1 ELSE 0 END) as negative
     FROM sentiment_records 
     WHERE is_noise = 0 AND created_at >= ? ${platform ? 'AND platform = ?' : ''}
     GROUP BY DATE(created_at)
     ORDER BY date DESC`,
    [...baseParams]
  );
  
  // 提取负面情绪关键词
  const negativeKeywords = db.queryAll(
    `SELECT topic_tag, COUNT(*) as cnt FROM sentiment_records 
     WHERE COALESCE(ai_sentiment, sentiment) = 'negative'
     AND is_noise = 0
     AND created_at >= ? ${platform ? 'AND platform = ?' : ''}
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
    const now = fmtLocalDate(new Date());
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
  
  if (twitterRows.length === 0 && discordRows.length === 0) {
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
    discord_topics: dedupByTag(discordRows.map(mapRow))
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
  
  const twCount = twitterRecords?.length || 0;
  const dcCount = discordRecords?.length || 0;
  console.log(`   数据: Twitter ${twCount} 条, Discord ${dcCount} 条`);
  
  if (twCount === 0 && dcCount === 0) {
    console.log('   ⚠️ 无数据，跳过分析');
    return { success: true, message: '无数据' };
  }
  
  // 调用 AI 分析
  const aiAnalyzer = require('./ai_analyzer');
  const result = await aiAnalyzer.aiSummarizeHotTopicsDual(twitterRecords, discordRecords);
  
  // 存入 topic_history
  // ★ 关键修复：传入 skipDedup=true，因为 result 已经是 AI 去重后的结果
  if (result.twitter_topics.length > 0) {
    saveTopicHistory(result.twitter_topics, 'twitter', true);
  }
  if (result.discord_topics.length > 0) {
    saveTopicHistory(result.discord_topics, 'discord', true);
  }
  
  console.log(`✅ 每日分析完成: Twitter ${result.twitter_topics.length} 个话题, Discord ${result.discord_topics.length} 个话题`);
  
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
    discord: result.discord_topics.length
  };
}

// ===== 获取话题趋势数据 =====
function getTopicTrend(platform, days = 7) {
  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = fmtLocalDate(startDate);
    
    const trends = db.queryAll(`
      SELECT 
        topic_title,
        DATE(created_at) as date,
        AVG(heat_score) as avg_heat,
        COUNT(*) as mention_count,
        GROUP_CONCAT(DISTINCT sentiment) as sentiments
      FROM topic_history
      WHERE platform = ? AND created_at >= ?
      GROUP BY topic_title, DATE(created_at)
      ORDER BY date DESC
    `, [platform, startDateStr]);
    
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
    
    const dateKey = fmtLocalDate(targetDate).substring(0, 10); // YYYY-MM-DD
    
    // 使用 8:30 时间窗口（与一日舆情一致）：dateKey 8:30 ~ dateKey+1天 8:30
    const windowStart = `${dateKey} 08:30:00`;
    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextDateKey = fmtLocalDate(nextDay).substring(0, 10);
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
      db.getDb().run('DELETE FROM daily_snapshots WHERE snapshot_date = ?', [dateKey]);
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
    db.getDb().run(
      'INSERT INTO daily_snapshots (snapshot_date, data_json, record_count, ai_topics_json) VALUES (?, ?, ?, ?)',
      [dateKey, '{}', recordCount, aiTopicsJson]  // data_json 设为空对象，因为不需要存原始记录
    );
    db.saveDb();
    
    console.log(`✅ 每日舆情快照保存成功: ${dateKey} (${recordCount}条记录)`);
    
    return {
      success: true,
      count: recordCount,
      date: dateKey,
      platforms: {
        twitter: aiTopics.twitter_topics.length,
        discord: aiTopics.discord_topics.length
      },
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
};
