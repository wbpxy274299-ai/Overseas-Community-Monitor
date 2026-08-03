/**
 * 舆情监控 + 周报管理路由
 */
const express = require('express');
const router = express.Router();
const { getDiscordToken } = require('../config');
const db = require('../db');
const sentiment = require('../sentiment');
const aiAnalyzer = require('../ai_analyzer');
const scheduler = require('../scheduler');
const weeklyReport = require('../weekly_report');
const { formatCst, nowCst } = require('../scanner');
const log = require('../logger');
const translator = require('../translator');
const { requireAuth, requireRole } = require('../middleware/auth');

// 跳过健康检查的认证（健康检查不需要登录）
router.use((req, res, next) => {
  if (req.path === '/health') return next();
  requireAuth(req, res, next);
});

// 清统计缓存辅助函数
function clearStatisticsCache() {
  statisticsCache = { data: null, timestamp: 0, ttl: 30 * 60 * 1000 };
}

// 统计数据缓存
let statisticsCache = { data: null, timestamp: 0, ttl: 30 * 60 * 1000 };

// ===== 每日分析锁 =====
// 打个比方：这把锁就像「今天已打过勾的考勤表」，同一天只允许 AI 分析跑一次
let dailyAnalysisLock = { date: null, analyzing: false };

function todayStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}

// ===== 健康检查 =====
router.get('/health', (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: 'v17.3'
  };
  try { db.queryOne('SELECT 1'); health.database = { ok: true }; }
  catch (e) { health.database = { ok: false, error: e.message }; health.status = 'degraded'; }
  try {
    const token = getDiscordToken('TC');
    health.discord = { ok: token && token.length > 10, tokenConfigured: !!token };
    if (!health.discord.ok) health.status = 'degraded';
  } catch (e) { health.discord = { ok: false, error: e.message }; health.status = 'degraded'; }
  res.status(health.status === 'ok' ? 200 : 503).json(health);
});

// ===== 舆情统计（只读数据库，不触发采集）=====
router.get('/api/sentiment/statistics', async (req, res) => {
  try {
    const period = req.query.period || 'week';
    const now = Date.now();
    if (statisticsCache.data && (now - statisticsCache.timestamp) < statisticsCache.ttl) {
      console.log('📊 使用缓存的统计数据');
      return res.json({ ok: true, data: statisticsCache.data, cached: true });
    }
    // 只从数据库读取，不触发实时采集（采集由定时任务负责）
    console.log('📊 从数据库读取统计数据...');
    const stats = sentiment.getStatistics(period);
    statisticsCache = { data: stats, timestamp: now, ttl: 30 * 60 * 1000 };
    res.json({ ok: true, data: stats, cached: false });
  } catch (e) {
    console.error('❌ 获取舆情统计失败:', e.message);
    log.error('获取舆情统计失败', e.message);
    res.status(500).json({ error: `获取统计失败: ${e.message}` });
  }
});

// ===== 反馈列表 =====
router.get('/api/sentiment/feedback', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const filters = {
      platform: req.query.platform,
      sentiment: req.query.sentiment,
      category: req.query.category,
      priority: req.query.priority ? parseInt(req.query.priority) : undefined,
    };
    const feedback = sentiment.getRecentFeedback(limit, filters);
    res.json({ ok: true, data: feedback });
  } catch (e) {
    log.error('获取反馈列表失败', e.message);
    res.status(500).json({ error: `获取反馈失败: ${e.message}` });
  }
});

// ===== 一日内舆情（发言原声）=====
router.get('/api/sentiment/daily', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const platform = req.query.platform || null;
    const dailyData = sentiment.getDailySentiment(limit, platform);
    res.json({ ok: true, data: dailyData, total: dailyData.length });
  } catch (e) {
    log.error('获取一日内舆情失败', e.message);
    res.status(500).json({ error: `获取一日内舆情失败: ${e.message}` });
  }
});

// ===== 实时玩家发言 =====
router.get('/api/sentiment/realtime', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const filters = { platform: req.query.platform, sentiment: req.query.sentiment };
    const realtimeData = sentiment.getRealtimeFeedback(limit, filters);
    res.json({ ok: true, data: realtimeData });
  } catch (e) {
    log.error('获取实时发言失败', e.message);
    res.status(500).json({ error: `获取实时发言失败: ${e.message}` });
  }
});

// ===== 历史数据 =====
router.get('/api/sentiment/history', (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 50;
    const platform = req.query.platform || null;
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;

    let whereClauses = ['is_noise = 0'];
    let params = [];
    if (platform) { whereClauses.push('platform = ?'); params.push(platform); }
    if (startDate) { whereClauses.push('created_at >= ?'); params.push(startDate + ' 00:00:00'); }
    if (endDate) { whereClauses.push('created_at <= ?'); params.push(endDate + ' 23:59:59'); }

    const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
    const countResult = db.queryOne(`SELECT COUNT(*) as total FROM sentiment_records ${whereSql}`, params);
    const total = countResult.total;
    const offset = (page - 1) * pageSize;
    const data = db.queryAll(
      `SELECT id, platform, author, content, translated_content, created_at, url, has_media, time_text
       FROM sentiment_records ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json({ success: true, data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  } catch (e) {
    log.error('获取历史数据失败', e.message);
    res.status(500).json({ error: `获取历史数据失败: ${e.message}` });
  }
});

// ===== 韩国社区帖子（历史数据页用）=====
router.get('/api/sentiment/lounge-posts', (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 20;
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;
    const sentiment = req.query.sentiment || null;
    const category = req.query.category || null;

    let whereClauses = ["author != 'GM 티메이' AND author != 'GM티메이'"];
    let params = [];
    if (startDate) { whereClauses.push('crawled_at >= ?'); params.push(startDate + 'T00:00:00'); }
    if (endDate) { whereClauses.push('crawled_at <= ?'); params.push(endDate + 'T23:59:59'); }
    if (sentiment) { whereClauses.push('sentiment = ?'); params.push(sentiment); }
    if (category) { whereClauses.push('ai_category = ?'); params.push(category); }

    const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const countResult = db.queryOne(`SELECT COUNT(*) as total FROM lounge_posts ${whereSql}`, params);
    const total = countResult?.total || 0;
    const offset = (page - 1) * pageSize;

    const posts = db.queryAll(
      `SELECT id, post_id, game_code, game_name, title, title_zh, author, content, content_zh,
              comment_count, view_count, url, sentiment, ai_category, ai_summary, crawled_at, post_time
       FROM lounge_posts ${whereSql} ORDER BY crawled_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    // 为每个帖子加载评论数统计
    for (const p of posts) {
      try {
        const cmtCount = db.queryOne(
          `SELECT COUNT(*) as cnt FROM lounge_comments WHERE post_id = ?`, [p.post_id]
        );
        p._comment_count = cmtCount?.cnt || 0;
      } catch (_) { p._comment_count = 0; }
    }

    res.json({ success: true, data: posts, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  } catch (e) {
    log.error('获取韩国帖子失败', e.message);
    res.status(500).json({ error: `获取韩国帖子失败: ${e.message}` });
  }
});

// ===== 韩国帖子详情（帖子内容 + 评论） =====
router.get('/api/sentiment/lounge-comments/:postId', (req, res) => {
  try {
    const { postId } = req.params;
    // 先获取帖子本身的内容
    const post = db.queryOne(
      `SELECT title, title_zh, content, content_zh, author, sentiment, ai_category, url, post_time, view_count, comment_count
       FROM lounge_posts WHERE post_id = ?`,
      [postId]
    );
    // 再获取评论
    const comments = db.queryAll(
      `SELECT id, author, content, content_zh, comment_time, likes, sentiment
       FROM lounge_comments WHERE post_id = ? ORDER BY comment_time ASC`,
      [postId]
    );
    res.json({ success: true, data: comments, post: post || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 韩国社区当日帖子（发言原声用） =====
router.get('/api/sentiment/lounge-daily', (req, res) => {
  try {
    const today = new Date().toLocaleDateString('sv-SE');
    const start = today + 'T00:00:00';
    const end = today + 'T23:59:59';
    const limit = parseInt(req.query.limit) || 200;
    const posts = db.queryAll(
      `SELECT title_zh, title, content_zh, author, url, sentiment, ai_category, post_time
       FROM lounge_posts
       WHERE crawled_at >= ? AND crawled_at <= ?
       AND author != 'GM 티메이' AND author != 'GM티메이'
       ORDER BY COALESCE(post_time, crawled_at) DESC LIMIT ?`,
      [start, end, limit]
    );
    res.json({ ok: true, data: posts, total: posts.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 采集进度追踪 =====
let collectProgress = {
  running: false,
  phase: '',        // 'twitter' | 'discord' | 'cleaning' | 'saving' | 'done' | 'error'
  twitterCount: 0,
  discordCount: 0,
  dedupCount: 0,       // 去重数量
  officialCount: 0,    // 过滤官方数量
  translateCount: 0,   // 翻译数量
  savedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  errors: [],           // 各平台错误信息
  message: '',
  startTime: null,
  endTime: null,
};

// ===== 手动采集（异步后台执行）=====
router.post('/api/sentiment/collect', requireRole('super_admin'), async (req, res) => {
  // 防卡死：如果采集状态已持续超过 15 分钟，自动重置（正常采集不会这么久）
  const stuckThreshold = 15 * 60 * 1000;
  if (collectProgress.running && collectProgress.startTime && (Date.now() - collectProgress.startTime) > stuckThreshold) {
    console.log('⚠️ 检测到采集状态卡死（超过15分钟），自动重置');
    collectProgress.running = false;
    sentiment.setIsCollecting(false);
  }

  if (sentiment.getIsCollecting() || collectProgress.running) {
    return res.json({ ok: false, message: '采集进行中，请稍后再试', collecting: true });
  }

  // 立即返回，后台执行
  res.json({ ok: true, message: '采集已启动，正在后台执行', collecting: true });

  // 后台异步执行采集（含清洗管线）
  (async () => {
    collectProgress = {
      running: true, phase: 'twitter',
      twitterCount: 0, discordCount: 0, dedupCount: 0, officialCount: 0, translateCount: 0,
      savedCount: 0, skippedCount: 0, failedCount: 0, errors: [],
      message: '正在采集 Twitter 数据...', startTime: Date.now(), endTime: null,
    };
    sentiment.setIsCollecting(true);
    console.log('📊 [手动采集] 开始采集 + 清洗管线...');

    try {
      // ====== 第1步：采集原始数据 ======
      let twitterRecords = [];
      try {
        twitterRecords = await sentiment.collectFromTwitter();
        collectProgress.twitterCount = twitterRecords.length;
        console.log(`📊 [采集] Twitter: ${twitterRecords.length} 条`);
      } catch (e) {
        console.error('📊 [采集] Twitter 失败:', e.message);
        collectProgress.errors.push({ source: 'Twitter', message: e.message });
      }

      collectProgress.phase = 'discord';
      collectProgress.message = '正在采集 Discord 数据...';
      let discordRecords = [];
      try {
        discordRecords = await sentiment.collectFromDiscord();
        collectProgress.discordCount = discordRecords.length;
        console.log(`📊 [采集] Discord: ${discordRecords.length} 条`);
      } catch (e) {
        console.error('📊 [采集] Discord 失败:', e.message);
        collectProgress.errors.push({ source: 'Discord', message: e.message });
      }

      let allRecords = [...twitterRecords, ...discordRecords];
      if (allRecords.length === 0) {
        collectProgress.phase = 'done';
        collectProgress.message = '采集完成，本次无新数据';
        collectProgress.endTime = Date.now();
        return;
      }

      // ====== 第2步：数据去重 ======
      collectProgress.phase = 'cleaning';
      collectProgress.message = `原始数据 ${allRecords.length} 条，正在去重...`;
      const dedupResult = sentiment.deduplicateRecords(allRecords);
      allRecords = dedupResult.records;
      collectProgress.dedupCount = dedupResult.dupCount;
      console.log(`📊 [去重] 原始 ${allRecords.length + dedupResult.dupCount} 条 → 去重后 ${allRecords.length} 条（移除 ${dedupResult.dupCount} 条重复）`);

      // ====== 第3步：过滤官方/运营发言 ======
      const filterResult = sentiment.filterOfficialRecords(allRecords);
      collectProgress.officialCount = filterResult.official.length;
      console.log(`📊 [过滤官方] 过滤 ${filterResult.official.length} 条官方发言，剩余 ${filterResult.normal.length} 条玩家发言`);

      // 官方发言翻译后存入反馈系统
      for (const offRecord of filterResult.official) {
        try {
          let translated = offRecord.content;
          if (translator.hasJapaneseCharacters(offRecord.content)) {
            translated = await translator.translateJapaneseToChinese(offRecord.content);
          }
          const platformLabel = offRecord.platform === 'twitter' ? 'Twitter' : 'Discord';
          const dateStr = todayStr();
          db.getDb().run(
            "INSERT INTO feedbacks (from_user, title, content, status) VALUES (?, ?, ?, 'unread')",
            ['系统采集', `运营发言-${platformLabel}-${dateStr}`, `【${offRecord.author}】${translated}${offRecord.url ? '\n原链接: ' + offRecord.url : ''}`]
          );
          db.saveDb();
        } catch (e) {
          console.warn('⚠️ 官方发言存反馈失败:', e.message);
        }
      }

      // ====== 第4步：批量翻译+打标签+入库 ======
      collectProgress.phase = 'saving';
      collectProgress.message = `正在保存 ${filterResult.normal.length} 条玩家发言（翻译+标签）...`;
      const result = await sentiment.batchSaveRecords(filterResult.normal, true);
      collectProgress.savedCount = result.success || 0;
      collectProgress.skippedCount = result.skipped || 0;
      collectProgress.failedCount = result.failed || 0;
      collectProgress.translateCount = result.translated || 0;
      console.log(`📊 [保存] 新增 ${result.success}, 翻译 ${result.translated}, 跳过 ${result.skipped}, 失败 ${result.failed}`);

      collectProgress.phase = 'done';
      const summary = [
        `Twitter ${collectProgress.twitterCount} 条`,
        `Discord ${collectProgress.discordCount} 条`,
      ].join(', ');
      const cleaning = [
        collectProgress.dedupCount > 0 ? `去重 ${collectProgress.dedupCount}` : '',
        collectProgress.officialCount > 0 ? `过滤官方 ${collectProgress.officialCount}` : '',
        collectProgress.translateCount > 0 ? `翻译 ${collectProgress.translateCount}` : '',
      ].filter(Boolean).join(', ');
      collectProgress.message = `采集完成！${summary}${cleaning ? ' | 清洗: ' + cleaning : ''}`;
      collectProgress.endTime = Date.now();
      console.log(`✅ [手动采集] 全部完成`);

      clearStatisticsCache();

    } catch (e) {
      log.error('手动采集舆情数据失败', e.message);
      collectProgress.phase = 'error';
      collectProgress.message = `采集失败: ${e.message}`;
      collectProgress.errors.push({ source: '系统', message: e.message });
      collectProgress.endTime = Date.now();
    } finally {
      collectProgress.running = false;
      sentiment.setIsCollecting(false);
    }
  })();
});

// ===== 手动触发 AI 分析（绕过每日一次限制）=====
router.post('/api/sentiment/force-analyze', requireRole('super_admin'), async (req, res) => {
  try {
    // 清除分析锁和缓存，强制重新分析
    dailyAnalysisLock = { date: null, analyzing: false };
    aiAnalyzer.clearTopicCache();
    sentiment.clearTodayTopics();
    console.log('🔄 [手动AI分析] 已清除缓存和锁，开始强制分析...');

    // 立即返回
    res.json({ ok: true, message: 'AI 分析已启动，请稍后刷新页面查看结果' });

    // 后台执行分析（复用 hot-topics 的逻辑）
    const { startDate, endDate, periodLabel } = sentiment.getTodayPeriod();
    console.log(`   周期: ${periodLabel}`);
    const twitterRecords = sentiment.getQualityFeedback(30, 'twitter', startDate, endDate);
    const discordRecords = sentiment.getQualityFeedback(30, 'discord', startDate, endDate);
    const loungeRecords = sentiment.getLoungeRecordsForAnalysis(startDate, endDate, 30);

    if ((!twitterRecords || twitterRecords.length === 0) &&
        (!discordRecords || discordRecords.length === 0) &&
        (!loungeRecords || loungeRecords.length === 0)) {
      console.log('⚠️ [手动AI分析] 无数据可分析');
      return;
    }

    console.log(`   📝 高质量数据: Twitter ${twitterRecords.length} 条, Discord ${discordRecords.length} 条, 韩服 ${loungeRecords.length} 条`);
    dailyAnalysisLock = { date: null, analyzing: true };
    try {
      const result = await aiAnalyzer.aiSummarizeHotTopicsDual(twitterRecords, discordRecords, loungeRecords);
      result.twitter_topics = dedupByTag(result.twitter_topics);
      result.discord_topics = dedupByTag(result.discord_topics);
      result.lounge_topics = dedupByTag(result.lounge_topics || []);
      sortByHeat(result.twitter_topics);
      sortByHeat(result.discord_topics);
      sortByHeat(result.lounge_topics);
      const totalTopics = result.twitter_topics.length + result.discord_topics.length + result.lounge_topics.length;
      console.log(`✅ [手动AI分析] 生成 ${result.twitter_topics.length} 个 Twitter 话题, ${result.discord_topics.length} 个 Discord 话题, ${result.lounge_topics.length} 个韩服话题`);

      if (result.twitter_topics.length > 0) sentiment.saveTopicHistory(result.twitter_topics, 'twitter', true);
      if (result.discord_topics.length > 0) sentiment.saveTopicHistory(result.discord_topics, 'discord', true);
      if (result.lounge_topics.length > 0) sentiment.saveTopicHistory(result.lounge_topics, 'lounge', true);

      dailyAnalysisLock = { date: todayStr(), analyzing: false };
      sentiment.getCollectionStatus().analysis.lastRun = new Date().toISOString();
      sentiment.getCollectionStatus().analysis.topicCount = totalTopics;
      console.log('🔒 [手动AI分析] 分析完成');
    } finally {
      dailyAnalysisLock.analyzing = false;
    }
  } catch (e) {
    dailyAnalysisLock.analyzing = false;
    console.error('❌ [手动AI分析] 失败:', e.message);
    log.error('手动AI分析失败', e.message);
  }
});

// ===== 分析变更检测（判断是否需要重新分析） =====
router.get('/api/sentiment/analysis-check', (req, res) => {
  try {
    const current = sentiment.getCurrentDataSnapshot();
    const last = sentiment.getAnalysisSnapshot();
    const cs = sentiment.getCollectionStatus();

    // 检查舆情面板是否有数据
    const todayTopics = sentiment.getTodayHotTopics();
    const hasTwitterTopics = todayTopics && todayTopics.twitter_topics && todayTopics.twitter_topics.length > 0;
    const hasDiscordTopics = todayTopics && todayTopics.discord_topics && todayTopics.discord_topics.length > 0;
    const hasLoungeTopics = todayTopics && todayTopics.lounge_topics && todayTopics.lounge_topics.length > 0;
    const panelComplete = hasTwitterTopics || hasDiscordTopics || hasLoungeTopics;

    // 检查数据是否变更
    const countChanged = current.recordCount !== last.recordCount;
    const dateChanged = current.maxUpdatedAt !== last.maxUpdatedAt;
    const dataChanged = countChanged || dateChanged;

    let needRefresh = false;
    let reason = '';

    if (!dataChanged && panelComplete) {
      needRefresh = false;
      reason = '数据无变化且面板内容完整，无需刷新';
    } else if (dataChanged) {
      needRefresh = true;
      const diff = current.recordCount - last.recordCount;
      reason = `历史数据已更新（${diff > 0 ? '新增' : '变化'} ${Math.abs(diff)} 条记录）`;
    } else if (!panelComplete) {
      needRefresh = true;
      reason = '舆情面板数据不完整，需要重新分析';
    }

    res.json({
      ok: true,
      needRefresh,
      reason,
      lastAnalysisAt: last.analyzedAt || null,
      recordCountChange: current.recordCount - last.recordCount,
      currentCount: current.recordCount,
      panelComplete,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== 刷新分析（智能版：先检测再分析） =====
router.post('/api/sentiment/refresh-analysis', requireRole('operator'), async (req, res) => {
  try {
    // 先检测是否需要刷新
    const current = sentiment.getCurrentDataSnapshot();
    const last = sentiment.getAnalysisSnapshot();
    const todayTopics = sentiment.getTodayHotTopics();
    const panelComplete = todayTopics && (
      (todayTopics.twitter_topics && todayTopics.twitter_topics.length > 0) ||
      (todayTopics.discord_topics && todayTopics.discord_topics.length > 0) ||
      (todayTopics.lounge_topics && todayTopics.lounge_topics.length > 0)
    );
    const dataChanged = current.recordCount !== last.recordCount || current.maxUpdatedAt !== last.maxUpdatedAt;

    if (!dataChanged && panelComplete) {
      return res.json({ ok: true, needRefresh: false, message: '数据无变化且面板完整，无需刷新分析' });
    }

    // 清除缓存和锁，执行分析
    dailyAnalysisLock = { date: null, analyzing: false };
    aiAnalyzer.clearTopicCache();
    sentiment.clearTodayTopics();

    res.json({ ok: true, needRefresh: true, message: 'AI 分析已启动，请稍后刷新查看结果' });

    // 后台执行分析
    const { startDate, endDate, periodLabel } = sentiment.getTodayPeriod();
    const twitterRecords = sentiment.getQualityFeedback(30, 'twitter', startDate, endDate);
    const discordRecords = sentiment.getQualityFeedback(30, 'discord', startDate, endDate);
    const loungeRecords = sentiment.getLoungeRecordsForAnalysis(startDate, endDate, 30);

    if ((!twitterRecords || twitterRecords.length === 0) &&
        (!discordRecords || discordRecords.length === 0) &&
        (!loungeRecords || loungeRecords.length === 0)) {
      console.log('⚠️ [刷新分析] 无数据可分析');
      return;
    }

    console.log(`   📝 高质量数据: Twitter ${twitterRecords.length} 条, Discord ${discordRecords.length} 条, 韩服 ${loungeRecords.length} 条`);
    dailyAnalysisLock = { date: null, analyzing: true };
    try {
      const result = await aiAnalyzer.aiSummarizeHotTopicsDual(twitterRecords, discordRecords, loungeRecords);
      result.twitter_topics = dedupByTag(result.twitter_topics);
      result.discord_topics = dedupByTag(result.discord_topics);
      result.lounge_topics = dedupByTag(result.lounge_topics || []);
      sortByHeat(result.twitter_topics);
      sortByHeat(result.discord_topics);
      sortByHeat(result.lounge_topics);

      if (result.twitter_topics.length > 0) sentiment.saveTopicHistory(result.twitter_topics, 'twitter', true);
      if (result.discord_topics.length > 0) sentiment.saveTopicHistory(result.discord_topics, 'discord', true);
      if (result.lounge_topics.length > 0) sentiment.saveTopicHistory(result.lounge_topics, 'lounge', true);

      dailyAnalysisLock = { date: todayStr(), analyzing: false };
      sentiment.getCollectionStatus().analysis.lastRun = new Date().toISOString();

      // 更新分析快照
      sentiment.setAnalysisSnapshot({
        recordCount: current.recordCount,
        maxUpdatedAt: current.maxUpdatedAt,
        analyzedAt: new Date().toISOString(),
      });
      console.log('✅ [刷新分析] 分析完成');
    } finally {
      dailyAnalysisLock.analyzing = false;
    }
  } catch (e) {
    dailyAnalysisLock.analyzing = false;
    console.error('❌ [刷新分析] 失败:', e.message);
    log.error('刷新分析失败', e.message);
  }
});

// ===== 采集进度查询 =====
router.get('/api/sentiment/collect-progress', (req, res) => {
  const elapsed = collectProgress.startTime
    ? Math.round(((collectProgress.endTime || Date.now()) - collectProgress.startTime) / 1000)
    : 0;
  res.json({
    ok: true,
    data: {
      ...collectProgress,
      elapsed,
    }
  });
});

// ===== 手动保存每日快照（仅管理员）=====
router.post('/api/sentiment/save-daily-snapshot', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { date } = req.body;
    const result = await sentiment.saveDailySnapshot(date);
    if (result.success) {
      res.json({ ok: true, message: '快照保存成功', count: result.count, date: result.date, platforms: result.platforms, ai_topics: result.ai_topics });
    } else {
      res.status(500).json({ ok: false, message: result.error || '保存失败' });
    }
  } catch (e) {
    log.error('保存每日快照失败', e.message);
    res.status(500).json({ error: `保存失败: ${e.message}` });
  }
});

// ===== 每日舆情快照列表（只读存档，不调AI）=====
router.get('/api/sentiment/daily-snapshots', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const snapshots = sentiment.getDailySnapshots(days);
    res.json({ ok: true, data: snapshots, total: snapshots.length });
  } catch (e) {
    log.error('获取每日快照列表失败', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== 某天的舆情快照详情（含AI分析结果）=====
router.get('/api/sentiment/daily-snapshots/:date', (req, res) => {
  try {
    const { date } = req.params;
    const detail = sentiment.getDailySnapshotDetail(date);
    if (!detail) {
      return res.status(404).json({ ok: false, error: '该日期无快照' });
    }
    res.json({ ok: true, data: detail });
  } catch (e) {
    log.error('获取每日快照详情失败', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== AI 热门话题（优先读已有分析，不重复调AI）=====
// 排序：热度高→低，发言多→少
const sortByHeat = (topics) => topics.sort((a, b) => (b.heat || 0) - (a.heat || 0) || (b.count || 0) - (a.count || 0));
// 按 tag 去重（同一个话题不重复展示）
const dedupByTag = (topics) => { const seen = new Set(); return (topics || []).filter(t => { if (seen.has(t.tag)) return false; seen.add(t.tag); return true; }); }

// 诊断函数：用大白话解释为什么没数据
function buildDiagnosisMessage(cs, twitterCount, discordCount) {
  const parts = [];
  // Twitter 采集状态
  const twErr = cs.twitter?.lastError;
  if (twErr) {
    parts.push(`🐦 Twitter 采集失败：${twErr}`);
  } else if (!cs.twitter?.lastRun) {
    parts.push('🐦 Twitter 今天还没采集过');
  } else {
    parts.push(`🐦 Twitter 采集了 ${cs.twitter.lastCount || 0} 条，但经质量筛选后无有效数据`);
  }
  // Discord 采集状态
  const dcErr = cs.discord?.lastError;
  if (dcErr) {
    parts.push(`💬 Discord 采集失败：${dcErr}`);
  } else if (!cs.discord?.lastRun) {
    parts.push('💬 Discord 今天还没采集过');
  } else {
    parts.push(`💬 Discord 采集了 ${cs.discord.lastCount || 0} 条，但经质量筛选后无有效数据`);
  }
  return parts.join('\n');
}

router.get('/api/sentiment/hot-topics', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const today = todayStr();
    
    if (force) {
      console.log('🔄 强制重新分析，清除缓存...');
      aiAnalyzer.clearTopicCache();
      sentiment.clearTodayTopics();
      dailyAnalysisLock = { date: null, analyzing: false };  // 重置锁
    }
    
    // 1. 先查今天是否已经有分析结果
    const existing = sentiment.getTodayHotTopics();
    if (existing && !force) {
      const totalTopics = (existing.twitter_topics?.length || 0) + (existing.discord_topics?.length || 0) + (existing.lounge_topics?.length || 0);
      if (totalTopics > 0) {
        sortByHeat(existing.twitter_topics);
        sortByHeat(existing.discord_topics);
        if (existing.lounge_topics) sortByHeat(existing.lounge_topics);
        console.log('📦 使用已有分析结果（不重复调AI）');
        return res.json({ ok: true, data: existing, cached: true });
      }
      // 今天有记录但话题为0，说明上次分析失败了，继续往下走重新分析
      console.log('⚠️ 今天有记录但话题为0，尝试重新分析...');
    }
    
    // 2. 检查当日分析锁：同一天只允许调一次 AI
    if (dailyAnalysisLock.date === today && !force) {
      console.log('🔒 今日 AI 分析已执行过，返回空结果（避免重复调用）');
      return res.json({ ok: true, data: { twitter_topics: [], discord_topics: [], lounge_topics: [] }, cached: true, locked: true });
    }
    
    // 3. 如果正在分析中，避免并发
    if (dailyAnalysisLock.analyzing) {
      console.log('⏳ AI 分析正在进行中，请稍候...');
      return res.json({ ok: true, data: { twitter_topics: [], discord_topics: [], lounge_topics: [] }, analyzing: true });
    }
    
    // 4. 调 AI 分析（先不锁，等成功了再锁）
    dailyAnalysisLock = { date: null, analyzing: true };
    try {
      console.log('🔥 今日无分析结果，开始调用 AI 分析...');
      const { startDate, endDate, periodLabel } = sentiment.getTodayPeriod();
      console.log(`   周期: ${periodLabel}`);
      const twitterRecords = sentiment.getQualityFeedback(30, 'twitter', startDate, endDate);
      const discordRecords = sentiment.getQualityFeedback(30, 'discord', startDate, endDate);
      const loungeRecords = sentiment.getLoungeRecordsForAnalysis(startDate, endDate, 30);
      if ((!twitterRecords || twitterRecords.length === 0) &&
          (!discordRecords || discordRecords.length === 0) &&
          (!loungeRecords || loungeRecords.length === 0)) {
        dailyAnalysisLock.analyzing = false;
        // ★ 诊断：为什么没数据？
        const cs = sentiment.getCollectionStatus();
        const diagnosis = {
          reason: 'no_data',
          detail: buildDiagnosisMessage(cs, 0, 0),
          twitterCount: 0,
          discordCount: 0,
          twitterError: cs.twitter?.lastError || null,
          discordError: cs.discord?.lastError || null,
          collectionTwitter: cs.twitter?.lastRun || null,
          collectionDiscord: cs.discord?.lastRun || null
        };
        return res.json({ ok: true, data: { twitter_topics: [], discord_topics: [], lounge_topics: [] }, diagnosis });
      }
      console.log(`   📝 高质量数据: Twitter ${twitterRecords.length} 条, Discord ${discordRecords.length} 条, 韩国 ${loungeRecords.length} 条`);
      const result = await aiAnalyzer.aiSummarizeHotTopicsDual(twitterRecords, discordRecords, loungeRecords);
      result.twitter_topics = dedupByTag(result.twitter_topics);
      result.discord_topics = dedupByTag(result.discord_topics);
      result.lounge_topics = dedupByTag(result.lounge_topics || []);
      sortByHeat(result.twitter_topics);
      sortByHeat(result.discord_topics);
      sortByHeat(result.lounge_topics);
      const totalTopics = result.twitter_topics.length + result.discord_topics.length + result.lounge_topics.length;
      console.log(`✅ AI 生成 ${result.twitter_topics.length} 个 Twitter 话题, ${result.discord_topics.length} 个 Discord 话题, ${result.lounge_topics.length} 个韩国话题`);
      if (result.twitter_topics.length > 0) sentiment.saveTopicHistory(result.twitter_topics, 'twitter', true);
      if (result.discord_topics.length > 0) sentiment.saveTopicHistory(result.discord_topics, 'discord', true);
      if (result.lounge_topics.length > 0) sentiment.saveTopicHistory(result.lounge_topics, 'lounge', true);
      
      // ★ 分析返回0个话题时，返回诊断信息而不是空数据
      if (totalTopics === 0) {
        dailyAnalysisLock = { date: null, analyzing: false };
        console.log('⚠️ 分析返回0个话题，不上锁（下次刷新可重试）');
        const cs = sentiment.getCollectionStatus();
        const diagnosis = {
          reason: 'ai_failed',
          detail: `采集到 Twitter ${twitterRecords.length} 条、Discord ${discordRecords.length} 条数据，但 AI 分析未能生成话题。可能是 AI 服务不可用，稍后会自动重试。`,
          twitterCount: twitterRecords.length,
          discordCount: discordRecords.length,
          twitterError: cs.twitter?.lastError || null,
          discordError: cs.discord?.lastError || null,
          collectionTwitter: cs.twitter?.lastRun || null,
          collectionDiscord: cs.discord?.lastRun || null
        };
        sentiment.getCollectionStatus().analysis.lastRun = new Date().toISOString();
        sentiment.getCollectionStatus().analysis.topicCount = 0;
        return res.json({ ok: true, data: result, diagnosis });
      }
      
      dailyAnalysisLock = { date: today, analyzing: false };
      console.log('🔒 分析成功，已上锁（今天不再重复调AI）');
      
      // 更新分析状态
      sentiment.getCollectionStatus().analysis.lastRun = new Date().toISOString();
      sentiment.getCollectionStatus().analysis.topicCount = totalTopics;
      
      res.json({ ok: true, data: result, cached: false });
    } finally {
      dailyAnalysisLock.analyzing = false;
    }
  } catch (e) {
    dailyAnalysisLock.analyzing = false;
    sentiment.recordError('热门话题API', e.message);
    console.error('❌ AI 热门话题生成失败:', e.message);
    log.error('AI 热门话题生成失败', e.message);
    res.status(500).json({ error: `AI 话题生成失败: ${e.message}` });
  }
});

// ===== 回溯标记（admin）=====
router.post('/api/sentiment/backfill', requireRole('admin', 'super_admin'), (req, res) => {
  try {
    const result = sentiment.backfillExistingRecords();
    clearStatisticsCache();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 历史去重（admin）=====
router.post('/api/sentiment/dedup', requireRole('admin', 'super_admin'), (req, res) => {
  try {
    const result = sentiment.deduplicateHistoricalData();
    clearStatisticsCache();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 话题趋势 =====
router.get('/api/sentiment/topic-trend', (req, res) => {
  try {
    const platform = req.query.platform || 'twitter';
    const days = parseInt(req.query.days) || 7;
    const trends = sentiment.getTopicTrend(platform, days);
    res.json({ ok: true, data: trends, platform, days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 情绪倾向分析 =====
router.get('/api/sentiment/sentiment-trend', (req, res) => {
  try {
    const platform = req.query.platform || null;
    const days = parseInt(req.query.days) || 7;
    const analysis = sentiment.getSentimentTrendAnalysis(platform, days);
    res.json({ ok: true, data: analysis, platform: platform || 'all', days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 清理数据（危险操作，仅管理员）=====
router.post('/api/sentiment/clear', requireRole('admin'), (req, res) => {
  try {
    const platform = req.query.platform;
    if (platform === 'discord') {
      db.execute(`DELETE FROM sentiment_records WHERE platform = 'discord'`);
      res.json({ ok: true, message: '已删除所有 Discord 记录', platform: 'discord' });
    } else if (platform === 'twitter') {
      db.execute(`DELETE FROM sentiment_records WHERE platform = 'twitter'`);
      res.json({ ok: true, message: '已删除所有 Twitter 记录', platform: 'twitter' });
    } else {
      db.execute(`DELETE FROM sentiment_records`);
      res.json({ ok: true, message: '已删除所有舆情记录', platform: 'all' });
    }
    clearStatisticsCache();
  } catch (e) {
    log.error('清理数据失败', e.message);
    res.status(500).json({ error: `清理失败: ${e.message}` });
  }
});

// ===== 批量 AI 分析（admin）=====
router.post('/api/sentiment/batch-ai-analyze', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { limit = 50 } = req.body;
    console.log(`🤖 开始批量 AI 分析（最多 ${limit} 条）...`);
    const records = db.queryAll(
      `SELECT * FROM sentiment_records WHERE ai_sentiment IS NULL AND is_noise = 0 ORDER BY created_at DESC LIMIT ?`,
      [limit]
    );
    if (records.length === 0) return res.json({ ok: true, message: '没有需要分析的数据' });
    console.log(`找到 ${records.length} 条待分析记录`);

    const analyzedRecords = await aiAnalyzer.batchAnalyze(records);
    let updated = 0;
    for (const record of analyzedRecords) {
      if (record.ai_sentiment) {
        db.getDb().run(
          `UPDATE sentiment_records SET ai_sentiment = ?, ai_confidence = ?, ai_reason = ?, ai_category = ? WHERE id = ?`,
          [record.ai_sentiment, record.ai_confidence, record.ai_reason, record.ai_category, record.id]
        );
        updated++;
      }
    }
    db.saveDb();
    console.log(`✅ AI 分析完成: 更新 ${updated}/${records.length} 条`);
    res.json({ ok: true, total: records.length, updated });
  } catch (e) {
    log.error('批量 AI 分析失败', e.message);
    res.status(500).json({ error: `分析失败: ${e.message}` });
  }
});

// ===== 标记已处理（operator + admin）=====
router.put('/api/sentiment/:id/process', requireRole('operator', 'admin'), (req, res) => {
  try {
    const recordId = parseInt(req.params.id);
    const { handler } = req.body;
    sentiment.markAsProcessed(recordId, handler);
    res.json({ ok: true });
  } catch (e) {
    log.error('标记处理失败', e.message);
    res.status(500).json({ error: `标记失败: ${e.message}` });
  }
});

// ===== 周报管理 =====

// 获取报告列表
router.get('/api/sentiment/reports', (req, res) => {
  try {
    const reports = db.queryAll(`SELECT * FROM weekly_reports ORDER BY created_at DESC`);
    res.json({ ok: true, data: reports });
  } catch (e) {
    log.error('获取报告列表失败', e.message);
    res.status(500).json({ error: `获取列表失败: ${e.message}` });
  }
});

// 生成新报告（admin only）
router.post('/api/weekly-report/generate', requireRole('admin'), async (req, res) => {
  try {
    console.log('📋 开始生成周报（Node.js原生版本）...');
    const result = await weeklyReport.generateWeeklyReport();
    if (!result.success) {
      return res.status(400).json({ ok: false, error: result.message || '生成失败' });
    }
    const now = formatCst(nowCst());
    const title = `舆情周报 - ${result.stats.dateRange.start.substring(0, 10)}`;
    const riskMap = { '🔴 高': 'high', '🟡 中': 'medium', '🟢 低': 'low' };
    const riskLevel = riskMap[result.stats.riskLevel] || (result.stats.riskLevel.includes('高') ? 'high' : result.stats.riskLevel.includes('中') ? 'medium' : 'low');
    
    // 去重：同标题已存在则更新
    const existingReport = db.queryOne('SELECT id FROM weekly_reports WHERE title = ?', [title]);
    if (existingReport) {
      db.getDb().run(`
        UPDATE weekly_reports SET content=?, risk_level=?, twitter_count=?, discord_count=?, summary=?, created_at=?
        WHERE id=?
      `, [result.report, riskLevel, result.stats.platforms.twitter.total, result.stats.platforms.discord_tc.total, result.summary ? result.summary.substring(0, 200) : '', now, existingReport.id]);
      console.log('✅ 周报已更新（同标题已存在）');
    } else {
      db.getDb().run(`
        INSERT INTO weekly_reports (title, content, risk_level, twitter_count, discord_count, summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [title, result.report, riskLevel, result.stats.platforms.twitter.total, result.stats.platforms.discord_tc.total, result.summary ? result.summary.substring(0, 200) : '', now]);
      console.log('✅ 周报生成成功！');
    }
    db.saveDb();
    res.json({ ok: true, message: '周报生成成功', data: { report: result.report, summary: result.summary, stats: result.stats } });
  } catch (e) {
    log.error('生成周报失败', e.message);
    console.error('❌ 异常详情:', e.stack);
    res.status(500).json({ error: `生成失败: ${e.message}` });
  }
});

// 检查上周数据
router.get('/api/weekly-report/check-data', async (req, res) => {
  try {
    const dateRange = weeklyReport.getLastWeekRange();
    console.log(`🔍 检查上周数据: ${dateRange.start} 至 ${dateRange.end}`);
    const allRecords = sentiment.getRecentFeedback(10000);
    const weeklyRecords = allRecords.filter(record => {
      const recordDate = new Date(record.created_at);
      return recordDate >= dateRange.startDate && recordDate <= dateRange.endDate;
    });
    console.log(`✅ 找到 ${weeklyRecords.length} 条上周记录`);
    const stats = {
      total: weeklyRecords.length,
      twitter: weeklyRecords.filter(r => r.platform === 'twitter').length,
      discord: weeklyRecords.filter(r => r.platform === 'discord' && !/[\u3040-\u309f\u30a0-\u30ff]/.test(r.content)).length,
      dateRange
    };
    if (weeklyRecords.length > 0) {
      const dates = weeklyRecords.map(r => new Date(r.created_at));
      const earliest = new Date(Math.min(...dates));
      const latest = new Date(Math.max(...dates));
      stats.actualRange = {
        start: earliest.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        end: latest.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      };
    }
    res.json({ ok: true, data: stats, sample: weeklyRecords.slice(0, 3) });
  } catch (e) {
    console.error('❌ 检查数据失败:', e);
    res.status(500).json({ error: e.message });
  }
});

// 获取单个报告
router.get('/api/sentiment/report/:id', (req, res) => {
  try {
    const reportId = parseInt(req.params.id);
    const report = db.queryOne('SELECT * FROM weekly_reports WHERE id = ?', [reportId]);
    if (!report) return res.status(404).json({ error: '报告不存在' });
    res.json({ ok: true, data: report });
  } catch (e) {
    log.error('获取报告失败', e.message);
    res.status(500).json({ error: `获取失败: ${e.message}` });
  }
});

// 下载报告
router.get('/api/sentiment/report/:id/download', (req, res) => {
  try {
    const reportId = parseInt(req.params.id);
    const report = db.queryOne('SELECT * FROM weekly_reports WHERE id = ?', [reportId]);
    if (!report) return res.status(404).json({ error: '报告不存在' });
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="yuqing_report_${reportId}.md"`);
    res.send(report.content);
  } catch (e) {
    log.error('下载报告失败', e.message);
    res.status(500).json({ error: `下载失败: ${e.message}` });
  }
});

// ===== 七日概览（逐日数据，前端趋势图用）=====
router.get('/api/sentiment/weekly-overview', (req, res) => {
  try {
    const overview = sentiment.getWeeklyOverview();
    res.json({ ok: true, data: overview });
  } catch (e) {
    log.error('获取七日概览失败', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== 七日热门话题（7日聚合数据 + AI概述）=====
router.get('/api/sentiment/weekly-hot-topics', async (req, res) => {
  try {
    const topics = await sentiment.getWeeklyHotTopics();
    res.json({ ok: true, data: topics });
  } catch (e) {
    log.error('获取七日热门话题失败', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== 每日舆情概述（无话题时的兑底）=====
router.get('/api/sentiment/daily-overview', (req, res) => {
  try {
    const overview = sentiment.getDailyOverview();
    res.json({ ok: true, data: overview });
  } catch (e) {
    log.error('获取每日舆情概述失败', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== 系统运行状态 API =====
router.get('/api/system/status', (req, res) => {
  try {
    const uptimeSeconds = Math.floor(process.uptime());
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const mins = Math.floor((uptimeSeconds % 3600) / 60);
    const mem = process.memoryUsage();
    
    const collectionStatus = sentiment.getCollectionStatus();
    const taskLog = scheduler.getTaskRunLog ? scheduler.getTaskRunLog() : {};
    const errors = sentiment.getSystemErrors().slice(0, 10);
    
    // 检查今日是否有热门话题分析
    const todayTopics = sentiment.getTodayHotTopics();
    const hasTopics = todayTopics && (todayTopics.twitter_topics?.length > 0 || todayTopics.discord_topics?.length > 0 || todayTopics.lounge_topics?.length > 0);
    
    res.json({
      ok: true,
      data: {
        uptime: `${days > 0 ? days + '天' : ''}${hours}时${mins}分`,
        uptimeSeconds,
        memory: `${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
        port: 5000,
        pid: process.pid,
        collection: collectionStatus,
        tasks: taskLog,
        topicsReady: hasTopics,
        topicCount: hasTopics ? (todayTopics.twitter_topics?.length || 0) + (todayTopics.discord_topics?.length || 0) : 0,
        errors: errors,
        errorCount: sentiment.getSystemErrors().length,
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 系统重启 API（危险操作，仅管理员）=====
router.post('/api/system/restart', requireRole('admin'), (req, res) => {
  console.log('\n🔄 用户触发系统重启...');
  res.json({ ok: true, message: '服务器正在重启...' });
  
  // 延迟 1 秒后重启（确保响应已发送）
  setTimeout(() => {
    try {
      scheduler.stopScheduler();
    } catch (_) {}
    process.exit(0);  // 退出后由外部进程管理器重启，或直接退出
  }, 1000);
});

// ===== 手动数据上传 API（operator 需额外 upload 权限，admin/super_admin 自动通过）=====
router.post('/api/sentiment/upload', requireRole('operator', 'admin'), async (req, res) => {
  // operator 需要单独的上传权限
  if (req.user.role === 'operator') {
    const userDb = require('../db');
    if (!userDb.hasUploadPermission(req.user.username)) {
      return res.status(403).json({
        ok: false,
        error: '无上传权限',
        message: '请联系管理员开通上传数据权限',
        code: 'NO_UPLOAD_PERMISSION',
      });
    }
  }
  if (sentiment.getIsCollecting()) {
    return res.json({ ok: false, message: '采集进行中，请稍后再试' });
  }
  
  try {
    sentiment.setIsCollecting(true);
    const { platform, data } = req.body;
    
    if (!platform || !data) {
      return res.status(400).json({ error: '缺少 platform 或 data 参数' });
    }
    
    let records = [];
    
    if (platform === 'twitter') {
      // Twitter CSV 格式解析
      // 字段：created_at, full_text, name, favorite_count, retweet_count, bookmark_count, quote_count, reply_count, views_count, url
      const rows = parseCsvRows(data);
      if (rows.length < 2) {
        return res.status(400).json({ error: 'CSV 数据不足，至少需要表头+1行数据' });
      }
      
      // 跳过表头
      for (let i = 1; i < rows.length; i++) {
        const fields = rows[i];
        if (fields.length < 10) continue;
        
        const [created_at, full_text, name, fav, rt, bm, qt, rp, views, url] = fields;
        if (!full_text || !url) continue;
        
        // 从 URL 提取 tweet ID
        const tweetId = url.split('/').pop().split('?')[0];
        
        // 时间转换：统一规范化为标准格式 YYYY-MM-DD HH:MM:SS
        const postTime = sentiment.normalizeDateTime(created_at);
        
        records.push({
          platform: 'twitter',
          source_id: tweetId,
          content: full_text.replace(/\\n/g, '\n'),
          author: name || '',
          channel_name: '手动上传',
          region: 'jp',
          created_at: postTime,
          url: url,
          has_media: 0,
          time_text: null,
        });
      }
    } else if (platform === 'discord') {
      // Discord 文本格式解析（智能版：逐行扫描，自动识别新消息头）
      // 支持：用户名 — 日期 时间\n内容   （单换行或双换行都能识别）
      let cleanData = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const allLines = cleanData.split('\n');
      
      // 头部正则：匹配 "用户名 — 日期 时间" 格式
      // 分隔符用 [^\w\s\u4e00-\u9fff] 匹配任何非字母非空格非汉字字符（em dash / en dash / 普通横杠 / 全角横杠等都能识别）
      const headerRegex = /^(.+?)\s*[^\w\s\u4e00-\u9fff]\s*(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}|\u6628\u5929\d{1,2}:\d{2}|\d{2}:\d{2})$/;
      
      console.log(`📝 Discord 解析开始: 总行数=${allLines.length}`);
      
      // 第一遍：逐行扫描，拆分成消息块
      const msgBlocks = []; // [{ headerLine, contentLines }]
      let current = null;
      
      for (const line of allLines) {
        const trimmed = line.trim();
        if (!trimmed) continue; // 跳过空行
        
        const match = trimmed.match(headerRegex);
        if (match) {
          // 这是一条新消息的头
          if (current && current.contentLines.length > 0) {
            msgBlocks.push(current);
          }
          current = { headerLine: trimmed, contentLines: [] };
        } else if (current) {
          // 这是当前消息的内容行
          current.contentLines.push(line);
        }
      }
      // 别忘了最后一条
      if (current && current.contentLines.length > 0) {
        msgBlocks.push(current);
      }
      console.log(`📝 Discord 解析: 识别到 ${msgBlocks.length} 条消息块`);
      
      // 第二遍：解析每条消息
      for (const block of msgBlocks) {
        const match = block.headerLine.match(headerRegex);
        if (!match) continue;
        
        const author = match[1].trim();
        const timeStr = match[2].trim();
        const content = block.contentLines.join('\n').trim();
        
        if (!content || content.length < 2) continue;
        // 跳过纯图片行
        if (content.replace(/图片/g, '').trim().length < 2) continue;
        
        // 解析时间："2026/7/23 22:06" 或 "昨天19:32" 或 "00:02"
        let postTime;
        try {
          if (timeStr.includes('昨天')) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const timeParts = timeStr.replace('昨天', '').trim().split(':');
            yesterday.setHours(parseInt(timeParts[0]), parseInt(timeParts[1] || 0), 0, 0);
            postTime = yesterday.getFullYear() + '-' + String(yesterday.getMonth()+1).padStart(2,'0') + '-' + String(yesterday.getDate()).padStart(2,'0') + ' ' + String(yesterday.getHours()).padStart(2,'0') + ':' + String(yesterday.getMinutes()).padStart(2,'0') + ':00';
          } else if (/^\d{2}:\d{2}$/.test(timeStr)) {
            // 只有时间，用今天
            const now = new Date();
            const [h, m] = timeStr.split(':').map(Number);
            postTime = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0') + ' ' + String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':00';
          } else {
            // 完整日期 "2026/7/23 22:06"
            const d = new Date(timeStr.replace(/\//g, '-'));
            if (!isNaN(d.getTime())) {
              postTime = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ':00';
            } else {
              postTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
            }
          }
        } catch (_) {
          postTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
        }
        
        const crypto = require('crypto');
        const contentHash = crypto.createHash('md5').update(content.substring(0, 100)).digest('hex').substring(0, 16);
        
        records.push({
          platform: 'discord',
          source_id: `manual_${Date.now()}_${contentHash}`,
          content: content,
          author: author,
          channel_name: '手动上传',
          region: 'tc',
          created_at: sentiment.normalizeDateTime(postTime),
          has_media: content.includes('图片') ? 1 : 0,
          time_text: null,
          url: null,
        });
      }
    } else {
      return res.status(400).json({ error: `不支持的平台: ${platform}` });
    }
    
    if (records.length === 0) {
      return res.json({ ok: false, message: '未解析到有效数据' });
    }
    
    console.log(`📤 手动上传: ${platform} ${records.length} 条记录`);
    const result = await sentiment.batchSaveRecords(records, true);
    
    res.json({
      ok: true,
      message: `上传成功`,
      platform,
      parsed: records.length,
      saved: result.success,
      skipped: result.skipped || 0,
      failed: result.failed,
    });
  } catch (e) {
    sentiment.recordError('手动上传', e.message);
    console.error('❌ 手动上传失败:', e.message);
    res.status(500).json({ error: `上传失败: ${e.message}` });
  } finally {
    sentiment.setIsCollecting(false);
  }
});

// CSV 状态机解析器：处理双引号内的逗号、换行和转义引号
function parseCsvRows(text) {
  const rows = [];
  let fields = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      fields.push(current);
      current = '';
      if (fields.length > 0) rows.push(fields);
      fields = [];
    } else {
      current += ch;
    }
  }
  // 处理末尾
  fields.push(current);
  if (fields.length > 0 && fields.some(f => f.trim())) rows.push(fields);
  
  return rows;
}

module.exports = router;
