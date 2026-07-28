/**
 * 术语校对 API 路由
 */
const express = require('express');
const router = express.Router();
const terminology = require('../terminology');

// 搜索术语 + 文本提取（校对）
router.get('/api/terminology/search', (req, res) => {
  const q = (req.query.q || '').trim();
  const text = (req.query.text || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  // 校对模式：从文本中提取术语
  if (text) {
    const matches = terminology.findTermsInText(text, limit);
    return res.json({ ok: true, results: matches });
  }

  // 搜索模式
  if (!q) return res.json({ ok: true, results: [] });
  const results = terminology.searchTerms(q, limit);
  res.json({ ok: true, results });
});

// 统计信息
router.get('/api/terminology/stats', (req, res) => {
  const stats = terminology.getStats();
  res.json({ ok: true, total: stats.total, version: stats.version });
});

module.exports = router;
