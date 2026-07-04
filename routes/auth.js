/**
 * 认证路由 — 登录 / 注册
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const log = require('../logger');
const { authLimiter } = require('../middleware/rateLimit');

// 登录
router.post('/api/login', authLimiter, (req, res) => {
  const { name = '', password = '' } = req.body;
  const n = name.trim();
  const s = password.trim();
  if (!n || !s) return res.status(400).json({ error: '请填写用户名和密码' });
  if (db.verifyUser(n, s)) {
    const role = db.getUserRole(n);
    log.info(`登录成功: ${n} (角色: ${role}, IP: ${req.ip})`);
    return res.json({ name: n, role, message: '登录成功' });
  }
  log.warn(`登录失败: ${n} (IP: ${req.ip})`);
  return res.status(401).json({ error: '用户名或密码错误' });
});

// 注册
router.post('/api/register', authLimiter, (req, res) => {
  const { name = '', password = '', confirm = '' } = req.body;
  const n = name.trim();
  const p = password.trim();
  const c = confirm.trim();
  if (!n || !p) return res.status(400).json({ error: '请填写用户名和密码' });
  if (n.length < 1 || n.length > 20) return res.status(400).json({ error: '用户名长度 1-20 个字符' });
  if (p.length < 4) return res.status(400).json({ error: '密码至少 4 个字符' });
  if (p !== c) return res.status(400).json({ error: '两次密码不一致' });
  if (db.userExists(n)) return res.status(400).json({ error: '用户名已存在，换一个吧' });
  if (db.createUser(n, p)) {
    log.info(`注册新用户: ${n}`);
    return res.json({ name: n, message: '注册成功，请登录' });
  }
  return res.status(500).json({ error: '注册失败，请稍后重试' });
});

module.exports = router;
