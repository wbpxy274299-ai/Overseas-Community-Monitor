/**
 * 页面渲染路由
 * - /login 无需认证
 * - 其他所有页面需要 ensureLoggedIn（未登录重定向到 /login）
 */
const express = require('express');
const path = require('path');
const router = express.Router();
const { ensureLoggedIn } = require('../middleware/auth');

// ===== 登录页（不检查认证，否则死循环）=====
router.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'google-login.html'));
});

// ===== 需要登录的页面 =====

// DC 发布主页
router.get('/', ensureLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'index.html'));
});

// 舆情监控面板
router.get('/sentiment', ensureLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'sentiment.html'));
});

// 舆情历史数据
router.get('/sentiment-history', ensureLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'sentiment-history.html'));
});

// 旧周报路径 → 重定向
router.get('/weekly-report', (req, res) => {
  res.redirect('/reports');
});

// 周报管理面板
router.get('/reports', ensureLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'reports.html'));
});

// 权限管理面板
router.get('/admin', ensureLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'admin.html'));
});

// 术语校对页面
router.get('/terminology', ensureLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'terminology.html'));
});

// 兼容旧路径：/google-login → /login
router.get('/google-login', (req, res) => {
  res.redirect('/login');
});

module.exports = router;
