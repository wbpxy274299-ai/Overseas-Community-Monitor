/**
 * Naver Lounge 监控 — API 路由
 * 放在 routes/ 目录下，文件名为 lounge.js
 *
 * 比喻：这是前台接待员，前端页面找它要数据，它去仓库（数据库）里拿
 *       也可以让爬虫"间谍"立刻出发去采集
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { ensureLoggedIn } = require('../middleware/auth');
const db = require('../db');
const { crawlLounge, getCrawlStatus, LOUNGE_CONFIG } = require('../lounge_crawler');
const translator = require('../translator');
const { getProxyConfig } = require('../config');

// ===== DeepSeek 通用调用（简单封装，避免依赖 ai_analyzer 内部函数）=====
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

async function callDeepSeek(prompt, userContent, options = {}) {
  if (!DEEPSEEK_API_KEY) {
    console.warn('⚠️ DeepSeek API Key 未配置');
    return '';
  }
  try {
    const response = await axios.post(DEEPSEEK_API_URL, {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: userContent },
      ],
      temperature: options.temperature || 0.3,
      max_tokens: options.maxTokens || 1000,
    }, {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
      proxy: getProxyConfig(),
    });
    return response.data?.choices?.[0]?.message?.content || '';
  } catch (err) {
    console.error('❌ DeepSeek 调用失败:', err.message);
    return '';
  }
}

// ===== 数据库表初始化 =====
function initLoungeTables() {
  const rawDb = db.getDb();
  // 帖子表
  rawDb.run(`
    CREATE TABLE IF NOT EXISTS lounge_posts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id         TEXT NOT NULL,              -- Lounge 原始帖子ID
      game_code       TEXT NOT NULL,              -- 游戏代码
      game_name       TEXT,                       -- 游戏名称
      title           TEXT NOT NULL,              -- 帖子标题（韩文）
      title_zh        TEXT,                       -- 标题中文翻译
      author          TEXT,                       -- 作者
      content         TEXT,                       -- 正文（韩文）
      content_zh      TEXT,                       -- 正文中文翻译
      images          TEXT,                       -- 图片URL列表（JSON数组）
      post_time       TEXT,                       -- 帖子发布时间
      comment_count   INTEGER DEFAULT 0,          -- 评论数
      view_count      INTEGER DEFAULT 0,          -- 浏览量
      url             TEXT,                       -- 原始链接
      sentiment       TEXT DEFAULT 'neutral',     -- 情感: positive/neutral/negative
      ai_category     TEXT,                       -- AI分类: bug/suggestion/complaint/praise/question/other
      ai_summary      TEXT,                       -- AI摘要（中文）
      crawled_at      TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
      UNIQUE(post_id, game_code)                  -- 同一帖子不重复入库
    )
  `);
  rawDb.run('CREATE INDEX IF NOT EXISTS idx_lounge_posts_game ON lounge_posts(game_code, crawled_at DESC)');
  rawDb.run('CREATE INDEX IF NOT EXISTS idx_lounge_posts_sentiment ON lounge_posts(sentiment)');

  // 评论表
  rawDb.run(`
    CREATE TABLE IF NOT EXISTS lounge_comments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id         TEXT NOT NULL,              -- 关联的帖子ID
      game_code       TEXT NOT NULL,
      author          TEXT,                       -- 评论者
      content         TEXT NOT NULL,              -- 评论内容（韩文）
      content_zh      TEXT,                       -- 评论中文翻译
      comment_time    TEXT,                       -- 评论时间
      likes           INTEGER DEFAULT 0,          -- 点赞数
      sentiment       TEXT DEFAULT 'neutral',
      crawled_at      TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
    )
  `);
  rawDb.run('CREATE INDEX IF NOT EXISTS idx_lounge_comments_post ON lounge_comments(post_id, game_code)');

  // 每日报告表
  rawDb.run(`
    CREATE TABLE IF NOT EXISTS lounge_daily_reports (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date     TEXT NOT NULL UNIQUE,        -- YYYY-MM-DD
      game_code       TEXT NOT NULL,
      total_posts     INTEGER DEFAULT 0,
      total_comments  INTEGER DEFAULT 0,
      positive_count  INTEGER DEFAULT 0,
      neutral_count   INTEGER DEFAULT 0,
      negative_count  INTEGER DEFAULT 0,
      hot_topics      TEXT,                        -- 热门话题（JSON）
      ai_summary      TEXT,                        -- AI日报总结（中文）
      alert_keywords  TEXT,                        -- 触发的预警关键词（JSON）
      created_at      TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
    )
  `);

  db.saveDb();
  console.log('✅ Lounge 监控数据表已初始化');
}

// ===== 数据入库 =====

/**
 * 将抓取结果存入数据库
 * @param {Object} crawlResult - crawlLounge() 的返回值
 */
function saveCrawlResult(crawlResult) {
  if (!crawlResult.success || !crawlResult.posts.length) return;

  let newPosts = 0, newComments = 0;

  for (const post of crawlResult.posts) {
    // 帖子入库（已存在则更新标题、作者等字段）
    try {
      db.getDb().run(
        `INSERT INTO lounge_posts
         (post_id, game_code, game_name, title, author, content, images,
          post_time, comment_count, view_count, url, crawled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(post_id, game_code) DO UPDATE SET
           title = excluded.title,
           author = excluded.author,
           post_time = excluded.post_time,
           comment_count = excluded.comment_count,
           view_count = excluded.view_count,
           content = CASE WHEN lounge_posts.content IS NULL OR lounge_posts.content = '' THEN excluded.content ELSE lounge_posts.content END`,
        [
          post.id, post.gameCode, post.gameName, post.title, post.author,
          post.content, JSON.stringify(post.images || []),
          post.time, post.commentCount, post.viewCount, post.url,
          post.crawledAt,
        ]
      );
      newPosts++;
    } catch (e) {
      // 兆底：如果 ON CONFLICT 不支持，回退到 UPDATE
      try {
        db.getDb().run(
          `UPDATE lounge_posts SET title = ?, author = ?, post_time = ?, comment_count = ?, view_count = ? WHERE post_id = ? AND game_code = ?`,
          [post.title, post.author, post.time, post.commentCount, post.viewCount, post.id, post.gameCode]
        );
      } catch (_) {}
    }

    // 评论入库
    for (const comment of (post.comments || [])) {
      try {
        db.getDb().run(
          `INSERT INTO lounge_comments
           (post_id, game_code, author, content, comment_time, likes, crawled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [post.id, post.gameCode, comment.author, comment.text,
           comment.time, parseInt(comment.likes) || 0, post.crawledAt]
        );
        newComments++;
      } catch (_) {}
    }
  }

  db.saveDb();
  console.log(`💾 入库完成：新增帖子 ${newPosts} 条，评论 ${newComments} 条`);
  return { newPosts, newComments };
}

// ===== 韩文翻译 + AI 分析 =====

/**
 * 对未翻译的帖子进行韩文→中文翻译和AI情感分析
 * 比喻：间谍把情报带回来了，现在让翻译官和分析师处理
 */
async function translateAndAnalyze(limit = 100) {
  const untranslated = db.queryAll(
    `SELECT id, post_id, title, content FROM lounge_posts
     WHERE content_zh IS NULL AND content IS NOT NULL AND content != ''
     ORDER BY crawled_at DESC LIMIT ?`,
    [limit]
  );

  if (untranslated.length === 0) {
    console.log('📝 没有需要翻译的帖子');
    return 0;
  }

  console.log(`🌐 开始翻译 ${untranslated.length} 条帖子...`);
  let translated = 0;

  for (const post of untranslated) {
    try {
      // 翻译标题
      let titleZh = '';
      if (post.title) {
        titleZh = await translator.translateKoreanToChinese(post.title);
      }

      // 翻译正文（截断到3000字，省API费用）
      let contentZh = '';
      if (post.content) {
        const truncated = post.content.substring(0, 3000);
        contentZh = await translator.translateKoreanToChinese(truncated);
      }

      // AI 情感分析 + 分类（简单规则 + DeepSeek 辅助）
      let sentiment = 'neutral';
      let aiCategory = 'other';
      let aiSummary = '';

      const analysisText = `标题: ${post.title}\n正文: ${(post.content || '').substring(0, 2000)}`;
      try {
        const aiPrompt = `你是游戏社区情感分析师。分析以下韩国游戏社区帖子，用JSON返回：
{"sentiment":"positive/neutral/negative","category":"bug/suggestion/complaint/praise/question/other","summary":"50字以内中文摘要"}
只返回JSON，不要其他内容。`;
        const aiRaw = await callDeepSeek(aiPrompt, analysisText, { maxTokens: 300, temperature: 0.1 });
        if (aiRaw) {
          const parsed = JSON.parse(aiRaw.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
          sentiment = parsed.sentiment || 'neutral';
          aiCategory = parsed.category || 'other';
          aiSummary = parsed.summary || '';
        }
      } catch (_) {
        // AI 分析失败，保持默认值
      }

      // 更新数据库
      db.getDb().run(
        `UPDATE lounge_posts SET title_zh = ?, content_zh = ?, sentiment = ?, ai_category = ?, ai_summary = ?
         WHERE id = ?`,
        [titleZh, contentZh, sentiment, aiCategory, aiSummary, post.id]
      );

      translated++;
      console.log(`  ✅ [${translated}/${untranslated.length}] ${post.title.substring(0, 20)}... → ${sentiment}`);

      // 翻译间隔，别把API打爆了
      await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      console.error(`  ❌ 翻译失败 #${post.id}: ${err.message}`);
    }
  }

  // 翻译评论（只翻译最新的）
  const untranslatedComments = db.queryAll(
    `SELECT id, content FROM lounge_comments
     WHERE content_zh IS NULL AND content != ''
     ORDER BY crawled_at DESC LIMIT ?`,
    [limit * 2]
  );

  for (const comment of untranslatedComments) {
    try {
      const zh = await translator.translateKoreanToChinese(comment.content);
      db.getDb().run(`UPDATE lounge_comments SET content_zh = ? WHERE id = ?`, [zh, comment.id]);
      await new Promise(r => setTimeout(r, 300));
    } catch (_) {}
  }

  db.saveDb();
  console.log(`✅ 翻译完成：${translated} 条帖子`);
  return translated;
}

// ===== 生成每日报告 =====

/**
 * 生成当日舆情日报
 */
async function generateDailyReport(gameCode) {
  const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD 格式

  const posts = db.queryAll(
    `SELECT * FROM lounge_posts WHERE game_code = ? AND DATE(crawled_at) = ?`,
    [gameCode, today]
  );

  const comments = db.queryAll(
    `SELECT * FROM lounge_comments WHERE game_code = ? AND DATE(crawled_at) = ?`,
    [gameCode, today]
  );

  if (posts.length === 0) {
    console.log('📊 今日无新帖子，跳过报告生成');
    return null;
  }

  // 统计情感分布
  const positive = posts.filter(p => p.sentiment === 'positive').length;
  const neutral = posts.filter(p => p.sentiment === 'neutral').length;
  const negative = posts.filter(p => p.sentiment === 'negative').length;

  // 预警关键词检测
  const ALERT_KEYWORDS = {
    '버그': 'BUG/故障',
    '오류': '错误',
    '접는다': '退坑',
    '접음': '退坑',
    '과금': '氪金',
    '현질': '充值',
    '서버': '服务器',
    '렉': '卡顿',
    '점검': '维护',
    '보상': '补偿',
    '불만': '不满',
    '실망': '失望',
    '최악': '最差',
    '망함': '完蛋',
    '삭제': '删除',
    '환불': '退款',
  };

  const triggeredAlerts = [];
  for (const post of posts) {
    const text = `${post.title} ${post.content || ''}`;
    for (const [keyword, label] of Object.entries(ALERT_KEYWORDS)) {
      if (text.includes(keyword)) {
        triggeredAlerts.push({
          keyword,
          label,
          postId: post.post_id,
          title: post.title_zh || post.title,
        });
      }
    }
  }

  // AI 生成日报总结
  const postSummary = posts.slice(0, 15).map(p =>
    `- [${p.sentiment}] ${p.title_zh || p.title} (${p.comment_count}条评论)`
  ).join('\n');

  let aiSummary = '';
  try {
    const prompt = `你是一个游戏社区运营分析师。请根据以下韩国游戏社区（Naver Lounge）的帖子列表，用中文写一份简短的每日舆情总结（200字以内）。
包含：1.今日整体氛围 2.热门话题 3.需要注意的风险点。

帖子列表：
${postSummary}

情感统计：正面${positive} / 中性${neutral} / 负面${negative}`;

    aiSummary = await callDeepSeek(prompt, postSummary, { maxTokens: 400 });
  } catch (_) {
    aiSummary = `今日共${posts.length}条帖子，正面${positive}/中性${neutral}/负面${negative}。`;
  }

  // 热门话题提取
  let hotTopics = [];
  try {
    const topicPrompt = `从以下韩国游戏社区帖子标题中提取3-5个热门话题关键词，用JSON数组格式返回，如 ["话题1","话题2"]。只返回JSON，不要其他内容。`;
    const titles = posts.map(p => p.title_zh || p.title).join('\n');
    const topicRaw = await callDeepSeek(topicPrompt, titles, { maxTokens: 200 });
    if (topicRaw) {
      const cleaned = topicRaw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      hotTopics = JSON.parse(cleaned);
    }
  } catch (_) {}

  // 存入报告表
  try {
    db.getDb().run(
      `INSERT OR REPLACE INTO lounge_daily_reports
       (report_date, game_code, total_posts, total_comments,
        positive_count, neutral_count, negative_count,
        hot_topics, ai_summary, alert_keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [today, gameCode, posts.length, comments.length,
       positive, neutral, negative,
       JSON.stringify(hotTopics), aiSummary, JSON.stringify(triggeredAlerts)]
    );
    db.saveDb();
    console.log(`📊 日报已生成：${today} (${gameCode})`);
  } catch (err) {
    console.error('❌ 日报存储失败:', err.message);
  }

  return {
    date: today,
    gameCode,
    totalPosts: posts.length,
    totalComments: comments.length,
    positive, neutral, negative,
    hotTopics,
    aiSummary,
    alerts: triggeredAlerts,
  };
}

// ===== 完整采集流程（定时任务调用）=====

/**
 * 一键执行：抓取 → 入库 → 翻译 → 分析 → 日报
 * 比喻：间谍出发 → 情报入库 → 翻译官翻译 → 分析师分析 → 写报告
 */
async function fullCrawlPipeline(options = {}) {
  console.log('\n🔄 ===== Lounge 完整采集流程启动 =====');

  // 第一步：抓取
  const crawlResult = await crawlLounge(options);
  if (!crawlResult.success) {
    console.error('❌ 抓取失败，流程终止');
    return { success: false, error: crawlResult.error };
  }

  // 第二步：入库
  const saved = saveCrawlResult(crawlResult);

  // 第三步：翻译 + AI分析
  const translated = await translateAndAnalyze(options.translateLimit || 100);

  // 第四步：生成日报
  const reports = [];
  for (const game of LOUNGE_CONFIG.games) {
    const report = await generateDailyReport(game.code);
    if (report) reports.push(report);
  }

  console.log('\n✅ ===== 完整采集流程结束 =====');
  return {
    success: true,
    crawl: { posts: crawlResult.posts.length, comments: crawlResult.totalComments, time: crawlResult.crawlTime },
    saved,
    translated,
    reports,
  };
}

// ===== API 路由 =====

// 获取帖子列表（分页）
router.get('/api/lounge/posts', ensureLoggedIn, (req, res) => {
  const { game, page = 1, size = 20, sentiment, keyword } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(size);

  let where = 'WHERE 1=1';
  const params = [];

  // 过滤 GM 官方帖子
  where += " AND author != 'GM 티메이' AND author != 'GM티메이'";

  if (game) { where += ' AND game_code = ?'; params.push(game); }
  if (sentiment) { where += ' AND sentiment = ?'; params.push(sentiment); }
  if (keyword) {
    where += ' AND (title LIKE ? OR title_zh LIKE ? OR content_zh LIKE ?)';
    const kw = `%${keyword}%`;
    params.push(kw, kw, kw);
  }

  try {
    const total = db.queryOne(`SELECT COUNT(*) as cnt FROM lounge_posts ${where}`, params);
    const posts = db.queryAll(
      `SELECT * FROM lounge_posts ${where} ORDER BY COALESCE(post_time, crawled_at) DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(size), offset]
    );

    res.json({
      success: true,
      data: posts,
      pagination: {
        page: parseInt(page),
        size: parseInt(size),
        total: total?.cnt || 0,
        totalPages: Math.ceil((total?.cnt || 0) / parseInt(size)),
      },
    });
  } catch (_) {
    res.json({ success: true, data: [], pagination: { page: 1, size: 20, total: 0, totalPages: 0 } });
  }
});

// 获取帖子详情（含评论）
router.get('/api/lounge/posts/:postId', ensureLoggedIn, (req, res) => {
  const { postId } = req.params;
  const { game } = req.query;

  try {
    const post = db.queryOne(
      'SELECT * FROM lounge_posts WHERE post_id = ? AND game_code = ?',
      [postId, game || 'Tree_Of_Savior_Neverland']
    );

    if (!post) {
      return res.json({ success: false, message: '帖子不存在' });
    }

    const comments = db.queryAll(
      'SELECT * FROM lounge_comments WHERE post_id = ? AND game_code = ? ORDER BY crawled_at ASC',
      [postId, game || 'Tree_Of_Savior_Neverland']
    );

    res.json({ success: true, data: { ...post, comments } });
  } catch (_) {
    res.json({ success: false, message: '数据表尚未初始化' });
  }
});

// 获取每日报告
router.get('/api/lounge/reports', ensureLoggedIn, (req, res) => {
  const { game, days = 7 } = req.query;
  try {
    const reports = db.queryAll(
      `SELECT * FROM lounge_daily_reports
       WHERE game_code = ?
       ORDER BY report_date DESC LIMIT ?`,
      [game || 'Tree_Of_Savior_Neverland', parseInt(days)]
    );
    res.json({ success: true, data: reports });
  } catch (_) {
    res.json({ success: true, data: [] });
  }
});

// 获取爬虫状态
router.get('/api/lounge/status', ensureLoggedIn, (req, res) => {
  const status = getCrawlStatus();
  let stats = null;
  try {
    stats = db.queryOne(`
      SELECT
        COUNT(*) as total_posts,
        SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END) as positive,
        SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END) as negative,
        SUM(CASE WHEN content_zh IS NOT NULL THEN 1 ELSE 0 END) as translated
      FROM lounge_posts
      WHERE author != 'GM 티메이' AND author != 'GM티메이'
    `);
  } catch (_) {
    stats = { total_posts: 0, positive: 0, negative: 0, translated: 0 };
  }
  res.json({ success: true, data: { ...status, stats } });
});

// 手动触发抓取（管理员操作）
router.post('/api/lounge/crawl', ensureLoggedIn, (req, res) => {
  // 权限检查：只有 admin 和 super_admin 可以手动触发
  if (!['admin', 'super_admin'].includes(req.user.role)) {
    return res.json({ success: false, message: '权限不足' });
  }

  const status = getCrawlStatus();
  if (status.isCrawling) {
    return res.json({ success: false, message: '爬虫正在运行中，请稍后再试' });
  }

  // 异步执行，不阻塞响应
  fullCrawlPipeline(req.body || {}).then(result => {
    console.log('📦 手动抓取流程完成:', JSON.stringify(result).substring(0, 200));
  }).catch(err => {
    console.error('❌ 手动抓取流程失败:', err.message);
  });

  res.json({ success: true, message: '抓取任务已启动，请稍后刷新查看结果' });
});

// 获取游戏列表
router.get('/api/lounge/games', ensureLoggedIn, (req, res) => {
  res.json({
    success: true,
    data: LOUNGE_CONFIG.games.map(g => ({ code: g.code, name: g.name, nameKr: g.nameKr })),
  });
});

module.exports = router;
module.exports.initLoungeTables = initLoungeTables;
module.exports.fullCrawlPipeline = fullCrawlPipeline;
module.exports.saveCrawlResult = saveCrawlResult;
module.exports.translateAndAnalyze = translateAndAnalyze;
module.exports.generateDailyReport = generateDailyReport;

// ===== 获取今日韩国数据统计（调度器调用）=====
function getTodayStats() {
  try {
    const stats = db.queryOne(`
      SELECT
        COUNT(*) as posts,
        SUM(CASE WHEN content_zh IS NOT NULL AND content_zh != '' THEN 1 ELSE 0 END) as translated,
        SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END) as positive,
        SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END) as negative,
        SUM(CASE WHEN sentiment='neutral' THEN 1 ELSE 0 END) as neutral
      FROM lounge_posts
      WHERE author != 'GM 티메이' AND author != 'GM티메이'
    `);
    return stats || { posts: 0, translated: 0, positive: 0, negative: 0, neutral: 0 };
  } catch (_) {
    return null;
  }
}
module.exports.getTodayStats = getTodayStats;
