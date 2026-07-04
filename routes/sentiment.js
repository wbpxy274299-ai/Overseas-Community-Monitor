/**
 * 舆情监控 + 周报管理路由
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const { getDiscordToken } = require('../config');
const db = require('../db');
const sentiment = require('../sentiment');
const aiAnalyzer = require('../ai_analyzer');
const scheduler = require('../scheduler');
const weeklyReport = require('../weekly_report');
const { formatCst, nowCst } = require('../scanner');
const log = require('../logger');
const { requireRole } = require('../middleware/validate');

// 统计数据缓存
let statisticsCache = { data: null, timestamp: 0, ttl: 30 * 60 * 1000 };

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

    let whereClauses = [];
    let params = [];
    if (platform) { whereClauses.push('platform = ?'); params.push(platform); }
    if (startDate) { whereClauses.push('created_at >= ?'); params.push(startDate + ' 00:00:00'); }
    if (endDate) { whereClauses.push('created_at <= ?'); params.push(endDate + ' 23:59:59'); }

    const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
    const countResult = db.queryOne(`SELECT COUNT(*) as total FROM sentiment_records ${whereSql}`, params);
    const total = countResult.total;
    const offset = (page - 1) * pageSize;
    const data = db.queryAll(
      `SELECT id, platform, author, content, created_at, url, has_media, time_text
       FROM sentiment_records ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json({ success: true, data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  } catch (e) {
    log.error('获取历史数据失败', e.message);
    res.status(500).json({ error: `获取历史数据失败: ${e.message}` });
  }
});

// ===== 手动采集 =====
router.post('/api/sentiment/collect', async (req, res) => {
  if (sentiment.getIsCollecting()) {
    return res.json({ ok: false, message: '采集进行中，请稍后再试', collecting: true });
  }
  try {
    sentiment.setIsCollecting(true);
    console.log('📊 开始采集 Twitter + Discord 舆情数据...');
    const enableAI = req.body.enableAI === true || req.query.enableAI === 'true';
    const twitterRecords = await sentiment.collectFromTwitter();
    const discordRecords = await sentiment.collectFromDiscord();
    const allRecords = [...twitterRecords, ...discordRecords];
    const result = await sentiment.batchSaveRecords(allRecords, enableAI);
    console.log(`✅ 采集完成: Twitter ${twitterRecords.length} 条, Discord ${discordRecords.length} 条`);
    res.json({
      ok: true, collected: allRecords.length,
      twitter_count: twitterRecords.length, discord_count: discordRecords.length,
      saved: result.success, skipped: result.skipped || 0, failed: result.failed,
      ai_enabled: enableAI
    });
  } catch (e) {
    log.error('采集舆情数据失败', e.message);
    res.status(500).json({ error: `采集失败: ${e.message}` });
  } finally {
    sentiment.setIsCollecting(false);
  }
});

// ===== 手动保存每日快照（仅管理员）=====
router.post('/api/sentiment/save-daily-snapshot', requireRole('admin'), async (req, res) => {
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

router.get('/api/sentiment/hot-topics', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    if (force) {
      // 清除数据库和内存缓存
      console.log('🔄 强制重新分析，清除缓存...');
      aiAnalyzer.clearTopicCache();
      sentiment.clearTodayTopics();
    }
    
    // 1. 先查今天是否已经有分析结果
    const existing = sentiment.getTodayHotTopics();
    if (existing && !force) {
      sortByHeat(existing.twitter_topics);
      sortByHeat(existing.discord_topics);
      console.log('📦 使用已有分析结果（不重复调AI）');
      console.log(`   Twitter: ${existing.twitter_topics.length} 个话题, Discord: ${existing.discord_topics.length} 个话题`);
      return res.json({ ok: true, data: existing, cached: true });
    }
    
    // 2. 没有分析结果，才调 AI（锁死前日8:30~今日8:30）
    console.log('🔥 今日无分析结果，开始调用 AI 分析...');
    const { startDate, endDate, periodLabel } = sentiment.getTodayPeriod();
    console.log(`   周期: ${periodLabel}`);
    const twitterRecords = sentiment.getQualityFeedback(30, 'twitter', startDate, endDate);
    const discordRecords = sentiment.getQualityFeedback(30, 'discord', startDate, endDate);
    if ((!twitterRecords || twitterRecords.length === 0) &&
        (!discordRecords || discordRecords.length === 0)) {
      return res.json({ ok: true, data: { twitter_topics: [], discord_topics: [] }, message: '暂无高质量数据' });
    }
    console.log(`   📝 高质量数据: Twitter ${twitterRecords.length} 条, Discord ${discordRecords.length} 条`);
    const result = await aiAnalyzer.aiSummarizeHotTopicsDual(twitterRecords, discordRecords);
    // ★ 读时去重：同 tag 只保留一条（与 getTodayHotTopics 保持一致）
    const dedupByTag = (topics) => {
      const seen = new Set();
      return (topics || []).filter(t => {
        if (seen.has(t.tag)) return false;
        seen.add(t.tag);
        return true;
      });
    };
    result.twitter_topics = dedupByTag(result.twitter_topics);
    result.discord_topics = dedupByTag(result.discord_topics);
    sortByHeat(result.twitter_topics);
    sortByHeat(result.discord_topics);
    console.log(`✅ AI 生成 ${result.twitter_topics.length} 个 Twitter 话题, ${result.discord_topics.length} 个 Discord 话题`);
    // ★ 关键修复：传入 skipDedup=true，因为 result 已经在路由层做过 dedupByTag
    // 避免 saveTopicHistory() 内部的二次去重把数据搞乱
    if (result.twitter_topics.length > 0) sentiment.saveTopicHistory(result.twitter_topics, 'twitter', true);
    if (result.discord_topics.length > 0) sentiment.saveTopicHistory(result.discord_topics, 'discord', true);
    res.json({ ok: true, data: result, cached: false });
  } catch (e) {
    console.error('❌ AI 热门话题生成失败:', e.message);
    log.error('AI 热门话题生成失败', e.message);
    res.status(500).json({ error: `AI 话题生成失败: ${e.message}` });
  }
});

// ===== 回溯标记 =====
router.post('/api/sentiment/backfill', (req, res) => {
  try {
    const result = sentiment.backfillExistingRecords();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 历史去重 =====
router.post('/api/sentiment/dedup', (req, res) => {
  try {
    const result = sentiment.deduplicateHistoricalData();
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

// ===== 清理数据（测试用）=====
router.post('/api/sentiment/clear', (req, res) => {
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
  } catch (e) {
    log.error('清理数据失败', e.message);
    res.status(500).json({ error: `清理失败: ${e.message}` });
  }
});

// ===== 手动生成周报 =====
router.post('/api/sentiment/generate-report', async (req, res) => {
  try {
    console.log('📋 手动触发周报生成...');
    const result = await weeklyReport.generateWeeklyReport();
    if (!result.success) {
      return res.status(400).json({ ok: false, error: result.message || '生成失败' });
    }
    const now = formatCst(nowCst());
    const title = `舆情周报 - ${result.stats.dateRange.start.substring(0, 10)}`;
    const riskMap = { '🔴 高': 'high', '🟡 中': 'medium', '🟢 低': 'low' };
    const riskLevel = riskMap[result.stats.riskLevel] || 'low';
    
    const existingReport = db.queryOne('SELECT id FROM weekly_reports WHERE title = ?', [title]);
    if (existingReport) {
      db.getDb().run(`UPDATE weekly_reports SET content=?, risk_level=?, twitter_count=?, discord_count=?, summary=?, created_at=? WHERE id=?`,
        [result.report, riskLevel, result.stats.platforms.twitter.total, result.stats.platforms.discord_tc.total, result.summary ? result.summary.substring(0, 200) : '', now, existingReport.id]);
    } else {
      db.getDb().run(`INSERT INTO weekly_reports (title, content, risk_level, twitter_count, discord_count, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [title, result.report, riskLevel, result.stats.platforms.twitter.total, result.stats.platforms.discord_tc.total, result.summary ? result.summary.substring(0, 200) : '', now]);
    }
    db.saveDb();
    res.json({ ok: true, message: '周报生成成功' });
  } catch (e) {
    log.error('生成周报失败', e.message);
    res.status(500).json({ error: `生成失败: ${e.message}` });
  }
});

// ===== 批量 AI 分析（修复：使用 aiAnalyzer.batchAnalyze）=====
router.post('/api/sentiment/batch-ai-analyze', async (req, res) => {
  try {
    const { limit = 50 } = req.body;
    console.log(`🤖 开始批量 AI 分析（最多 ${limit} 条）...`);
    const records = db.queryAll(
      `SELECT * FROM sentiment_records WHERE ai_sentiment IS NULL ORDER BY created_at DESC LIMIT ?`,
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

// ===== 标记已处理 =====
router.put('/api/sentiment/:id/process', (req, res) => {
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

// 生成新报告（Node.js 原生）
router.post('/api/weekly-report/generate', async (req, res) => {
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

module.exports = router;
