/**
 * 页面渲染路由
 */
const express = require('express');
const path = require('path');
const router = express.Router();

// DC 发布主页
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'index.html'));
});

// 舆情监控面板
router.get('/sentiment', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'sentiment.html'));
});

// 舆情历史数据
router.get('/sentiment-history', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'sentiment-history.html'));
});

// 旧周报路径 → 重定向
router.get('/weekly-report', (req, res) => {
  res.redirect('/reports');
});

// 周报管理面板
router.get('/reports', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'reports.html'));
});

// 权限管理面板
router.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'admin.html'));
});

// Google SSO 登录页面
router.get('/google-login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'google-login.html'));
});

module.exports = router;
