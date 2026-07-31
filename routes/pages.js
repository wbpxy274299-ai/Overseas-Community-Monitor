/**
 * 页面渲染路由
 * - /login 无需认证
 * - pending 用户：所有页面显示"待审批"提示
 * - 其他角色：正常加载页面，UI 层根据权限置灰/隐藏
 * - 玩家洞察：仅 super_admin 可访问
 *
 * 角色权限表：
 *   pending     → 无任何权限，显示待审批提示
 *   viewer      → 舆情监控、术语校对、反馈
 *   operator    → DC发布、舆情监控、周报(只读)、历史数据(只读)、术语校对、反馈
 *   admin       → 全部页面(除玩家洞察) + 权限管理
 *   super_admin → 全部页面 + 权限管理 + 玩家洞察 + 删除用户
 */
const express = require('express');
const path = require('path');
const router = express.Router();
const { ensureLoggedIn } = require('../middleware/auth');
const db = require('../db');

// ===== 登录页（不检查认证，否则死循环）=====
router.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'google-login.html'));
});

// ===== DC 发布主页（operator + admin + super_admin）=====
router.get('/', ensureLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'index.html'));
});

// ===== 舆情监控面板（所有角色）=====
router.get('/sentiment', ensureLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'sentiment.html'));
});

// ===== 舆情历史数据（operator + admin + super_admin）=====
router.get('/sentiment-history', ensureLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'sentiment-history.html'));
});

// 旧周报路径 → 重定向
router.get('/weekly-report', (req, res) => {
  res.redirect('/reports');
});

// ===== 周报管理面板（operator 只读 + admin + super_admin）=====
router.get('/reports', ensureLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'reports.html'));
});

// ===== 权限管理面板（admin + super_admin）=====
router.get('/admin', ensureLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'admin.html'));
});

// ===== 玩家洞察（仅 super_admin）=====
router.get('/insights', ensureLoggedIn, (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.redirect('/sentiment');
  }
  res.sendFile(path.join(__dirname, '..', 'views', 'insights.html'));
});

// ===== 术语校对页面（所有角色）=====
router.get('/terminology', ensureLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'terminology.html'));
});

// ===== 贴文助手（operator + admin + super_admin，需有 postAssistant 权限）=====
router.get('/post-assistant', ensureLoggedIn, (req, res) => {
  // admin/super_admin 默认有权限
  if (req.user.role === 'admin' || req.user.role === 'super_admin') {
    return res.sendFile(path.join(__dirname, '..', 'views', 'post-assistant.html'));
  }
  // 检查 postAssistant 权限
  const perms = db.getUserPermissions(req.user.username);
  if (!perms.postAssistant) {
    return res.redirect('/sentiment');
  }
  res.sendFile(path.join(__dirname, '..', 'views', 'post-assistant.html'));
});

// 兼容旧路径：/google-login → /login
router.get('/google-login', (req, res) => {
  res.redirect('/login');
});

module.exports = router;
