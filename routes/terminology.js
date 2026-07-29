/**
 * 术语校对 API 路由
 */
const express = require('express');
const router = express.Router();
const axios = require('axios');
const terminology = require('../terminology');
const { getProxyConfig } = require('../config');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// 搜索术语 + 文本提取（校对）
router.get('/api/terminology/search', (req, res) => {
  const q = (req.query.q || '').trim();
  const text = (req.query.text || '').trim();
  const lang = (req.query.lang || 'auto').trim();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  // 校对模式：从文本中提取术语（支持指定语言）
  if (text) {
    const matches = terminology.findTermsInText(text, limit, lang);
    return res.json({ ok: true, results: matches });
  }

  // 搜索模式
  if (!q) return res.json({ ok: true, results: [] });
  const results = terminology.searchTerms(q, limit);
  res.json({ ok: true, results });
});

// 批量校对
router.post('/api/terminology/batch-check', (req, res) => {
  const { lines, lang } = req.body;
  if (!lines || !Array.isArray(lines) || !lines.length) {
    return res.status(400).json({ error: '请提供文案列表' });
  }
  if (lines.length > 500) {
    return res.status(400).json({ error: '单次最多 500 条' });
  }
  const results = terminology.batchCheck(lines, lang || 'jp');
  res.json({ ok: true, results, total: lines.length });
});

// AI 代理（DeepSeek API）
router.post('/api/terminology/ai', requireAuth, async (req, res) => {
  const { system, question, source } = req.body;
  if (!question) return res.status(400).json({ error: '请提供问题内容' });

  // 贴文助手来源 → 检查次数限制（超级管理员不限）
  if (source === 'post-assistant') {
    const username = req.user.username;
    const isSuperAdmin = req.user.role === 'super_admin';
    if (!isSuperAdmin) {
      const remaining = db.getTranslationRemaining(username);
      if (remaining <= 0) {
        return res.status(429).json({
          error: '今日翻译次数已用完',
          message: '💡 阿饱的个人自费 AI API，为避免阿饱破产，每人每天限 15 次。明天再来吧！',
          remaining: 0,
          limit: db.DAILY_TRANSLATION_LIMIT,
        });
      }
    }
  }

  const apiKey = process.env.DEEPSEEK_API_KEY || '';
  if (!apiKey) return res.status(500).json({ error: 'DEEPSEEK_API_KEY 未配置' });

  try {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: question });

    const resp = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      { model: 'deepseek-chat', messages, temperature: 0.7, max_tokens: 4000 },
      {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 60000,
        proxy: getProxyConfig(),
      }
    );
    const content = resp.data?.choices?.[0]?.message?.content || '';

    // 贴文助手来源 → 扣减次数
    let remaining = null;
    if (source === 'post-assistant') {
      const isSuperAdmin = req.user.role === 'super_admin';
      if (!isSuperAdmin) {
        db.incrementTranslationUsage(req.user.username);
        remaining = db.getTranslationRemaining(req.user.username);
      }
    }

    res.json({ ok: true, data: { content }, remaining });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    res.status(500).json({ error: 'AI 调用失败: ' + msg });
  }
});

// 查询剩余翻译次数
router.get('/api/terminology/translation-remaining', requireAuth, (req, res) => {
  const username = req.user.username;
  const isSuperAdmin = req.user.role === 'super_admin';
  const used = db.getTranslationUsage(username);
  const limit = db.DAILY_TRANSLATION_LIMIT;
  const remaining = isSuperAdmin ? Infinity : db.getTranslationRemaining(username);
  res.json({ ok: true, data: { used, limit, remaining, isSuperAdmin } });
});

// Gemini AI 代理（支持图片+文字，贴文助手专用）
router.post('/api/terminology/gemini', async (req, res) => {
  const { question, images } = req.body;
  if (!question) return res.status(400).json({ error: '请提供问题内容' });

  const apiKey = process.env.GEMINI_API_KEY || '';
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY 未配置' });

  try {
    const model = 'gemini-2.0-flash-exp';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // 构建请求：图片 + 文字
    const parts = [];
    if (images && images.length) {
      for (const img of images) {
        parts.push({ inline_data: { mime_type: img.mimeType || 'image/jpeg', data: img.data } });
      }
    }
    parts.push({ text: question });

    const resp = await axios.post(apiUrl,
      { contents: [{ parts }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 90000, proxy: getProxyConfig() }
    );
    const content = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json({ ok: true, data: { content } });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    res.status(500).json({ error: 'Gemini 调用失败: ' + msg });
  }
});

// 术语表更新（合并 Excel 解析后的数据）
router.post('/api/terminology/merge', (req, res) => {
  const { updates } = req.body;
  if (!updates || !Array.isArray(updates) || !updates.length) {
    return res.status(400).json({ error: '请提供术语数据' });
  }
  if (updates.length > 50000) {
    return res.status(400).json({ error: '单次最多 50000 条' });
  }
  const result = terminology.mergeTerms(updates);
  res.json({ ok: true, ...result });
});

// 统计信息
router.get('/api/terminology/stats', (req, res) => {
  const stats = terminology.getStats();
  res.json({ ok: true, total: stats.total, version: stats.version, languages: terminology.LANG_KEYS });
});

module.exports = router;
