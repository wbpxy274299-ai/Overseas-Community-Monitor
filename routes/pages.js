/**
 * 页面渲染路由
 * - /login 无需认证
 * - 其他所有页面需要 ensureLoggedIn（未登录重定向到 /login）
 * - 按角色控制页面访问权限
 *
 * 角色权限表：
 *   viewer   → 舆情监控、术语校对、反馈
 *   operator → DC发布、舆情监控、周报(只读)、历史数据(只读)、术语校对、反馈
 *   admin    → 全部页面 + 权限管理
 */
const express = require('express');
const path = require('path');
const router = express.Router();
const { ensureLoggedIn } = require('../middleware/auth');

const FORBIDDEN_PAGE = '<h1>403 - 权限不足</h1><p>你没有权限访问此页面。<a href="/">返回首页</a></p>';

// ===== 登录页（不检查认证，否则死循环）=====
router.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'google-login.html'));
});

// ===== DC 发布主页（operator + admin）=====
router.get('/', ensureLoggedIn, (req, res) => {
  if (!['operator', 'admin'].includes(req.user.role)) {
    return res.status(403).send(FORBIDDEN_PAGE);
  }
  res.sendFile(path.join(__dirname, '..', 'views', 'index.html'));
});

// ===== 舆情监控面板（所有角色）=====
router.get('/sentiment', ensureLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'sentiment.html'));
});

// ===== 舆情历史数据（operator 只读 + admin）=====
router.get('/sentiment-history', ensureLoggedIn, (req, res) => {
  if (!['operator', 'admin'].includes(req.user.role)) {
    return res.status(403).send(FORBIDDEN_PAGE);
  }
  res.sendFile(path.join(__dirname, '..', 'views', 'sentiment-history.html'));
});

// 旧周报路径 → 重定向
router.get('/weekly-report', (req, res) => {
  res.redirect('/reports');
});

// ===== 周报管理面板（operator 只读 + admin）=====
router.get('/reports', ensureLoggedIn, (req, res) => {
  if (!['operator', 'admin'].includes(req.user.role)) {
    return res.status(403).send(FORBIDDEN_PAGE);
  }
  res.sendFile(path.join(__dirname, '..', 'views', 'reports.html'));
});

// ===== 权限管理面板（仅 admin）=====
router.get('/admin', ensureLoggedIn, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).send(FORBIDDEN_PAGE);
  }
  res.sendFile(path.join(__dirname, '..', 'views', 'admin.html'));
});

// ===== 术语校对页面（所有角色）=====
router.get('/terminology', ensureLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'terminology.html'));
});

// 兼容旧路径：/google-login → /login
router.get('/google-login', (req, res) => {
  res.redirect('/login');
});

module.exports = router;
