/**
 * 求助 / 反馈路由
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const log = require('../logger');
const { requireRole } = require('../middleware/validate');

// 提交反馈（任何登录用户）
router.post('/api/feedback', (req, res) => {
  const operator = decodeURIComponent(req.headers['x-operator'] || '');
  if (!operator) {
    return res.status(401).json({ error: '未登录' });
  }
  const { title, content } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: '标题和内容不能为空' });
  }
  try {
    db.getDb().run(
      'INSERT INTO feedbacks (from_user, title, content) VALUES (?, ?, ?)',
      [operator, title.slice(0, 100), content.slice(0, 2000)]
    );
    db.saveDb();
    log.info(`用户 ${operator} 提交了反馈: ${title}`);
    res.json({ ok: true, message: '反馈已提交，管理员会尽快处理' });
  } catch (e) {
    log.error('提交反馈失败', e.message);
    res.status(500).json({ error: `提交失败: ${e.message}` });
  }
});

// 获取反馈列表（仅管理员）
router.get('/api/feedback', requireRole('admin'), (req, res) => {
  try {
    const rows = db.queryAll(
      'SELECT * FROM feedbacks ORDER BY created_at DESC LIMIT 100'
    );
    res.json({ ok: true, data: rows });
  } catch (e) {
    log.error('获取反馈列表失败', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 获取未读数量（仅管理员，用于红点）
router.get('/api/feedback/unread-count', requireRole('admin'), (req, res) => {
  try {
    const row = db.queryOne(
      "SELECT COUNT(*) AS cnt FROM feedbacks WHERE status = 'unread'"
    );
    res.json({ ok: true, count: row ? row.cnt : 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 更新反馈状态（仅管理员）
router.put('/api/feedback/:id/status', requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['unread', 'read', 'resolved'].includes(status)) {
    return res.status(400).json({ error: '无效的状态值' });
  }
  try {
    db.getDb().run('UPDATE feedbacks SET status = ? WHERE id = ?', [status, id]);
    db.saveDb();
    res.json({ ok: true, message: '状态已更新' });
  } catch (e) {
    log.error('更新反馈状态失败', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
