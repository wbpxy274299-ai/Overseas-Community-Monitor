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
const { fmtCST8Date } = require('../config');
const { crawlLounge, getCrawlStatus, getCrawlProgress, LOUNGE_CONFIG, parseKoreanTime } = require('../lounge_crawler');
const translator = require('../translator');
const { sanitizeForAI } = require('../ai_analyzer'); // ★ 文本消毒：半个emoji会让DeepSeek拒收整个请求

/**
 * 从韩文时间字符串提取实际发布日期
 * @param {string} koreanTime - 韩文时间 (如 "06.16", "2026-08-05 10:17:00", "1시간 전")
 * @param {string} crawledAt - 抓取时间 (ISO 格式)
 * @returns {string|null} YYYY-MM-DD 格式日期
 */
function extractPostDate(koreanTime, crawledAt) {
  if (!koreanTime) return null;
  
  // 1. 尝试解析 "YYYY-MM-DD HH:mm:ss" 或 "YYYY-MM-DDTHH:mm:ss" 格式（Naver API 实际返回的格式）
  const fullDateMatch = koreanTime.match(/^(\d{4})-(\d{2})-(\d{2})[T ]/);
  if (fullDateMatch) {
    return `${fullDateMatch[1]}-${fullDateMatch[2]}-${fullDateMatch[3]}`;
  }
  
  // 2. 尝试解析 "MM.DD" 格式 (如 "06.16")
  const match = koreanTime.match(/^(\d{2})\.(\d{2})$/);
  if (match) {
    const month = parseInt(match[1]);
    const day = parseInt(match[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      // 假设年份是当前年份
      const year = new Date().getFullYear();
      return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
  }
  
  // 3. 相对时间 (如 "1시간 전") 或解析失败，使用抓取时间
  if (crawledAt) {
    const d = new Date(crawledAt);
    if (!isNaN(d.getTime())) {
      return fmtCST8Date(d);
    }
  }
  
  return null;
}

// ===== DeepSeek 通用调用（简单封装，避免依赖 ai_analyzer 内部函数）=====
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

async function callDeepSeek(prompt, userContent, options = {}) {
  if (!DEEPSEEK_API_KEY) {
    console.warn('⚠️ DeepSeek API Key 未配置');
    return '';
  }

  const cleanContent = sanitizeForAI(userContent); // ★ 消毒：半个emoji（孤立代理项）会让 DeepSeek 以 400 拒收整个请求
  
  const maxRetries = 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(DEEPSEEK_API_URL, {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: cleanContent },
        ],
        temperature: options.temperature || 0.3,
        max_tokens: options.maxTokens || 1000,
      }, {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      });
      return response.data?.choices?.[0]?.message?.content || '';
    } catch (err) {
      // 429 限流：等待后重试
      if (err.response?.status === 429 && attempt < maxRetries) {
        const retryAfter = err.response.data?.retry_after || 5;
        console.warn(`⏳ DeepSeek 限流，${retryAfter}秒后重试 (${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      // 网络错误：短暂等待后重试
      if ((err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') && attempt < maxRetries) {
        console.warn(`⏳ DeepSeek 网络错误，3秒后重试 (${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      // ★ 有响应体但被拒（如 400）：把拒收原因完整打出来，方便定位
      if (err.response) {
        const body = typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data);
        console.error(`❌ DeepSeek 调用 HTTP ${err.response.status}（内容约${(cleanContent || '').length}字）`);
        console.error(`   拒收原因: ${(body || '').substring(0, 600)}`);
        return '';
      }
      // 其他错误或已达最大重试次数
      console.error(`❌ DeepSeek 调用失败 (尝试${attempt}次): ${err.message}`);
      return '';
    }
  }
  return '';
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
      post_date       TEXT,                       -- 帖子实际发布日期 (YYYY-MM-DD)
      UNIQUE(post_id, game_code)                  -- 同一帖子不重复入库
    )
  `);
  rawDb.run('CREATE INDEX IF NOT EXISTS idx_lounge_posts_game ON lounge_posts(game_code, crawled_at DESC)');
  rawDb.run('CREATE INDEX IF NOT EXISTS idx_lounge_posts_sentiment ON lounge_posts(sentiment)');

  // ★ 表结构迁移：给旧表补加缺失列（CREATE TABLE IF NOT EXISTS 不会改已有表）
  const migrateColumns = [
    'ALTER TABLE lounge_posts ADD COLUMN game_name TEXT',
    'ALTER TABLE lounge_posts ADD COLUMN title_zh TEXT',
    'ALTER TABLE lounge_posts ADD COLUMN content_zh TEXT',
    'ALTER TABLE lounge_posts ADD COLUMN sentiment TEXT DEFAULT \'neutral\'',
    'ALTER TABLE lounge_posts ADD COLUMN ai_category TEXT',
    'ALTER TABLE lounge_posts ADD COLUMN ai_summary TEXT',
    'ALTER TABLE lounge_posts ADD COLUMN post_date TEXT',
  ];
  for (const sql of migrateColumns) {
    try { rawDb.run(sql); } catch (_) { /* 列已存在，跳过 */ }
  }

  // ★ 数据回填：把已有数据的 post_date 从 post_time 提取出来（NULL 和空串都补，幂等）
  // post_time 格式为 "YYYY-MM-DD HH:mm:ss"，用 substr 取前10位
  try {
    const backfillResult = rawDb.run(
      `UPDATE lounge_posts SET post_date = substr(post_time, 1, 10) WHERE (post_date IS NULL OR post_date = '') AND post_time IS NOT NULL AND post_time != ''`
    );
    if (backfillResult.changes > 0) {
      console.log(`✅ 回填 post_date: ${backfillResult.changes} 条`);
    }
  } catch (_) { /* 忽略 */ }

  // ★ 数据修复：旧代码用 toISOString() 存了 ISO 格式（含 T 和 Z），统一为标准格式
  // ISO 格式: "2026-08-07T02:00:00.000Z" → 标准格式: "2026-08-07 02:00:00"
  try {
    const fixCrawledAt = rawDb.run(
      `UPDATE lounge_posts SET crawled_at = REPLACE(REPLACE(SUBSTR(crawled_at, 1, 19), 'T', ' '), 'Z', '') WHERE crawled_at LIKE '%T%'`
    );
    if (fixCrawledAt.changes > 0) {
      console.log(`✅ 修复 crawled_at 格式: ${fixCrawledAt.changes} 条 (ISO→标准)`);
    }
    const fixPostTime = rawDb.run(
      `UPDATE lounge_posts SET post_time = REPLACE(REPLACE(SUBSTR(post_time, 1, 19), 'T', ' '), 'Z', '') WHERE post_time LIKE '%T%'`
    );
    if (fixPostTime.changes > 0) {
      console.log(`✅ 修复 post_time 格式: ${fixPostTime.changes} 条 (ISO→标准)`);
    }
  } catch (e) { console.warn('⚠️ 修复日期格式失败:', e.message); }

  // ★ 数据修复：评论时间也可能存了 ISO 格式
  try {
    const fixCommentISO = rawDb.run(
      `UPDATE lounge_comments SET comment_time = REPLACE(REPLACE(SUBSTR(comment_time, 1, 19), 'T', ' '), 'Z', '') WHERE comment_time LIKE '%T%'`
    );
    if (fixCommentISO.changes > 0) {
      console.log(`✅ 修复 comment_time 格式: ${fixCommentISO.changes} 条 (ISO→标准)`);
    }
    // 紧凑格式 "20260404192948" → 标准格式 "2026-04-04 19:29:48"
    const fixCommentCompact = rawDb.run(
      `UPDATE lounge_comments SET comment_time = SUBSTR(comment_time,1,4)||'-'||SUBSTR(comment_time,5,2)||'-'||SUBSTR(comment_time,7,2)||' '||SUBSTR(comment_time,9,2)||':'||SUBSTR(comment_time,11,2)||':'||SUBSTR(comment_time,13,2) WHERE comment_time NOT LIKE '%-%' AND LENGTH(comment_time) = 14`
    );
    if (fixCommentCompact.changes > 0) {
      console.log(`✅ 修复 comment_time 格式: ${fixCommentCompact.changes} 条 (紧凑→标准)`);
    }
  } catch (e) { console.warn('⚠️ 修复 comment_time 格式失败:', e.message); }

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
  if (!crawlResult.success || !crawlResult.posts.length) {
    console.warn('⚠️ saveCrawlResult: 无数据可入库 (success=' + crawlResult.success + ', posts=' + (crawlResult.posts?.length || 0) + ')');
    return { newPosts: 0, newComments: 0, error: '无数据' };
  }

  // ★ 预检：数据库是否就绪
  const database = db.getDb();
  if (!database) {
    console.error('❌ saveCrawlResult: 数据库未初始化 (getDb() 返回 null)，无法入库！');
    return { newPosts: 0, newComments: 0, error: '数据库未初始化' };
  }

  // ★ 预检：lounge_posts 表是否存在
  try {
    database.run('SELECT 1 FROM lounge_posts LIMIT 1');
  } catch (tableErr) {
    console.error('❌ saveCrawlResult: lounge_posts 表不存在！', tableErr.message);
    return { newPosts: 0, newComments: 0, error: 'lounge_posts 表不存在' };
  }

  let newPosts = 0, newComments = 0, failedPosts = 0, failedComments = 0;
  const firstError = { post: null, comment: null };

  for (const post of crawlResult.posts) {
    // 帖子入库（已存在则更新标题、作者等字段）
    try {
      db.getDb().run(
        `INSERT INTO lounge_posts
         (post_id, game_code, game_name, title, author, content, images,
          post_time, post_date, comment_count, view_count, url, crawled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(post_id, game_code) DO UPDATE SET
           title = excluded.title,
           author = excluded.author,
           post_time = excluded.post_time,
           post_date = excluded.post_date,
           comment_count = excluded.comment_count,
           view_count = excluded.view_count,
           content = CASE WHEN lounge_posts.content IS NULL OR lounge_posts.content = '' THEN excluded.content ELSE lounge_posts.content END`,
        [
          post.id, post.gameCode, post.gameName, post.title, post.author,
          post.content, JSON.stringify(post.images || []),
          parseKoreanTime(post.time, post.crawledAt),
          extractPostDate(post.time, post.crawledAt),
          post.commentCount, post.viewCount, post.url,
          post.crawledAt,
        ]
      );
      newPosts++;
    } catch (e) {
      failedPosts++;
      if (!firstError.post) firstError.post = { id: post.id, error: e.message };
      // 回退：尝试简单 UPDATE
      try {
        db.getDb().run(
          `UPDATE lounge_posts SET title = ?, author = ?, post_time = ?, comment_count = ?, view_count = ? WHERE post_id = ? AND game_code = ?`,
          [post.title, post.author, parseKoreanTime(post.time, post.crawledAt), post.commentCount, post.viewCount, post.id, post.gameCode]
        );
        failedPosts--; // UPDATE 成功则撤销失败计数
        newPosts++;
      } catch (e2) {
        console.error(`❌ 帖子 #${post.id} 入库失败: ${e2.message}`);
      }
    }

    // 评论入库
    for (const comment of (post.comments || [])) {
      try {
        db.getDb().run(
          `INSERT INTO lounge_comments
           (post_id, game_code, author, content, comment_time, likes, crawled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [post.id, post.gameCode, comment.author, comment.text,
           parseKoreanTime(comment.time, post.crawledAt), parseInt(comment.likes) || 0, post.crawledAt]
        );
        newComments++;
      } catch (e) {
        failedComments++;
        if (!firstError.comment) firstError.comment = { postId: post.id, error: e.message };
      }
    }
  }

  db.saveDb();

  // ★ 入库结果汇总（含错误信息）
  console.log(`💾 入库完成：帖子 ${newPosts} 条${failedPosts > 0 ? '（失败 ' + failedPosts + ' 条）' : ''}，评论 ${newComments} 条${failedComments > 0 ? '（失败 ' + failedComments + ' 条）' : ''}`);
  if (firstError.post) console.error('   首个帖子错误:', firstError.post);
  if (firstError.comment) console.error('   首个评论错误:', firstError.comment);

  return { newPosts, newComments, failedPosts, failedComments, error: failedPosts > 0 ? firstError.post?.error : null };
}

// ===== 帖子正文清洗 =====
// 比喻：爬虫抓回来的内容像从垃圾桶里捡出来的，什么都有——评论、时间戳、作者名、按钮文字
// 这个函数就是“垃圾分类员”，把有用的正文留下，噪音扔掉
function cleanLoungeContent(text) {
  if (!text) return '';
  let t = text;

  // 1. 去掉时间戳模式：07.18、07.19、2024.07.18、14:30、14:30:00
  t = t.replace(/\d{2,4}[.\/\-]\d{1,2}[.\/\-]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g, ' ');
  t = t.replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ');

  // 2. 去掉常见的作者名前缀模式："作者 xxx"、"xxx 作者"、"작성자 xxx"
  t = t.replace(/(?:作者|작성자|writer|author)\s*[:：]?\s*\S{1,10}/gi, ' ');

  // 3. 去掉 Naver 按钮/投票文字（这些不是帖子内容）
  t = t.replace(/\b(?:buff|nerf|버프|너프|추천|비추천|공감|비공감)\b/g, ' ');

  // 4. 去掉重复行（连续3次以上相同的短文本块）
  const lines = t.split('\n');
  const cleaned = [];
  let prevLine = '';
  let repeatCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === prevLine && trimmed.length < 50) {
      repeatCount++;
      if (repeatCount <= 2) cleaned.push(trimmed); // 最多保留2次重复
    } else {
      repeatCount = 0;
      if (trimmed) cleaned.push(trimmed);
    }
    prevLine = trimmed;
  }
  t = cleaned.join('\n');

  // 5. 去掉过短的行（少于3个字符的碎片）
  t = t.split('\n').filter(l => l.trim().length >= 3).join('\n');

  // 6. 压缩连续空行
  t = t.replace(/\n{3,}/g, '\n\n');

  // 7. 去掉首尾空白
  return t.trim();
}

// ===== 韩文翻译 + AI 分析 =====

/**
 * 对未翻译的帖子进行韩文→中文翻译和AI情感分析
 * 比喻：间谍把情报带回来了，现在让翻译官和分析师处理
 */
async function translateAndAnalyze(limit = 100) {
  const untranslated = db.queryAll(
    `SELECT id, post_id, title, content FROM lounge_posts
     WHERE (content_zh IS NULL OR content_zh = '') AND content IS NOT NULL AND content != ''
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

      // 翻译正文（先清洗再去翻译，省API费用 + 提高翻译质量）
      let contentZh = '';
      if (post.content) {
        const cleaned = cleanLoungeContent(post.content);
        const truncated = cleaned.substring(0, 3000);
        contentZh = await translator.translateKoreanToChinese(truncated);
        // 翻译后再清洗一次（去掉翻译残留的噪音）
        contentZh = cleanLoungeContent(contentZh);
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
     WHERE (content_zh IS NULL OR content_zh = '') AND content != ''
     ORDER BY crawled_at DESC LIMIT ?`,
    [limit * 2]
  );

  for (const comment of untranslatedComments) {
    try {
      const zh = await translator.translateKoreanToChinese(comment.content);
      db.getDb().run(`UPDATE lounge_comments SET content_zh = ? WHERE id = ?`, [zh, comment.id]);
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.warn(`  ⚠️ 评论翻译失败 #${comment.id}: ${e.message}`);
    }
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
  // ★ 口径统一：按 post_date（发帖日期）统计 + 除官方 GM 帖，与日报概述/历史页一致；
  //   旧代码用 DATE(crawled_at)（抓取时间）且不除官方，晚上发的帖次日才抓就漏算
  const today = fmtCST8Date(new Date());
  const OFFICIAL = "AND author NOT IN ('GM 티메이', 'GM티메이')";

  const posts = db.queryAll(
    `SELECT * FROM lounge_posts WHERE game_code = ? AND post_date = ? ${OFFICIAL}`,
    [gameCode, today]
  );

  const comments = db.queryAll(
    `SELECT * FROM lounge_comments WHERE game_code = ? AND DATE(crawled_at) = ? ${OFFICIAL}`,
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
  } catch (e) {
    console.warn(`  ⚠️ 热门话题提取失败: ${e.message}`);
  }

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

  // ★ 检查入库结果
  if (!saved || saved.newPosts === 0) {
    console.error('❌ 入库失败：0 条帖子成功入库');
    if (saved?.error) console.error('   原因:', saved.error);
    return { success: false, error: '入库失败: ' + (saved?.error || '0条帖子入库'), crawl: { posts: crawlResult.posts.length } };
  }
  console.log(`✅ 入库成功：${saved.newPosts} 条帖子，${saved.newComments} 条评论`);

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
    `);
  } catch (_) {
    stats = { total_posts: 0, positive: 0, negative: 0, translated: 0 };
  }
  res.json({ success: true, data: { ...status, stats } });
});

// 获取抓取进度
router.get('/api/lounge/progress', ensureLoggedIn, (req, res) => {
  const progress = getCrawlProgress();
  res.json({ success: true, data: progress });
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

// 批量清洗已有脏数据（content 和 content_zh）
router.post('/api/lounge/clean-content', ensureLoggedIn, async (req, res) => {
  try {
    const posts = db.queryAll(
      `SELECT id, content, content_zh FROM lounge_posts WHERE content IS NOT NULL AND content != ''`
    );
    let cleaned = 0;
    for (const post of posts) {
      const newContent = cleanLoungeContent(post.content);
      const newContentZh = post.content_zh ? cleanLoungeContent(post.content_zh) : post.content_zh;
      if (newContent !== post.content || newContentZh !== post.content_zh) {
        db.getDb().run(
          `UPDATE lounge_posts SET content = ?, content_zh = ? WHERE id = ?`,
          [newContent, newContentZh, post.id]
        );
        cleaned++;
      }
    }
    db.saveDb();
    res.json({ success: true, message: `清洗完成，共处理 ${posts.length} 条，更新 ${cleaned} 条` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 获取游戏列表
router.get('/api/lounge/games', ensureLoggedIn, (req, res) => {
  res.json({
    success: true,
    data: LOUNGE_CONFIG.games.map(g => ({ code: g.code, name: g.name, nameKr: g.nameKr })),
  });
});

// 清空韩国社区数据（只清 lounge 表，不影响用户/任务等其他数据）
router.post('/api/lounge/clear-data', ensureLoggedIn, (req, res) => {
  if (!['admin', 'super_admin'].includes(req.user.role)) {
    return res.json({ success: false, message: '权限不足' });
  }
  try {
    const rawDb = db.getDb();
    rawDb.run('DROP TABLE IF EXISTS lounge_posts');
    rawDb.run('DROP TABLE IF EXISTS lounge_comments');
    rawDb.run('DROP TABLE IF EXISTS lounge_daily_reports');
    db.saveDb();
    // 重建表结构
    initLoungeTables();
    console.log('✅ 韩国社区数据已清空，表结构已重建');
    res.json({ success: true, message: '韩国社区数据已清空，可以重新抓取' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 删除指定日期之前的韩国社区数据
router.post('/api/lounge/delete-before', ensureLoggedIn, (req, res) => {
  if (!['admin', 'super_admin'].includes(req.user.role)) {
    return res.json({ success: false, message: '权限不足' });
  }
  const { beforeDate } = req.body; // 格式: "2026-05-01"
  if (!beforeDate || !/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) {
    return res.json({ success: false, message: '日期格式错误，需要 YYYY-MM-DD 格式' });
  }
  try {
    const rawDb = db.getDb();
    // 删除帖子（post_date 或 crawled_at 早于指定日期）
    const postResult = rawDb.run(
      `DELETE FROM lounge_posts WHERE post_date < ? OR (post_date IS NULL AND crawled_at < ?)`,
      [beforeDate, beforeDate + ' 00:00:00']
    );
    // 删除关联评论（帖子已被删的）
    const deletedPostIds = db.queryAll(
      `SELECT post_id FROM lounge_posts WHERE post_date >= ? OR (post_date IS NULL AND crawled_at >= ?)`,
      [beforeDate, beforeDate + ' 00:00:00']
    );
    const keptIds = new Set(deletedPostIds.map(r => r.post_id));
    const allPostIds = db.queryAll('SELECT DISTINCT post_id FROM lounge_comments');
    let commentDeleted = 0;
    for (const row of allPostIds) {
      if (!keptIds.has(row.post_id)) {
        const r = rawDb.run('DELETE FROM lounge_comments WHERE post_id = ?', [row.post_id]);
        commentDeleted += r.changes;
      }
    }
    // 删除旧日报
    const reportResult = rawDb.run('DELETE FROM lounge_daily_reports WHERE report_date < ?', [beforeDate]);
    db.saveDb();
    console.log(`✅ 删除 ${beforeDate} 之前的数据：帖子 ${postResult.changes} 条，评论 ${commentDeleted} 条，日报 ${reportResult.changes} 条`);
    res.json({ success: true, message: `已删除 ${beforeDate} 之前的数据：帖子 ${postResult.changes} 条，评论 ${commentDeleted} 条，日报 ${reportResult.changes} 条` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
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
    `);
    return stats || { posts: 0, translated: 0, positive: 0, negative: 0, neutral: 0 };
  } catch (_) {
    return null;
  }
}
module.exports.getTodayStats = getTodayStats;
