/**
 * 受保护的路由示例 - 展示如何使用认证和角色校验中间件
 */
const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const log = require('../logger');

/**
 * 示例1: 需要登录才能访问的接口
 * GET /api/protected/info
 */
router.get('/info', requireAuth, (req, res) => {
  // req.user 已经由 requireAuth 中间件附加
  res.json({
    message: '这是受保护的信息',
    user: {
      id: req.user.userId,
      username: req.user.username,
      email: req.user.email,
      role: req.user.role
    }
  });
});

/**
 * 示例2: 需要 admin 权限才能访问的接口
 * GET /api/protected/admin-only
 */
router.get('/admin-only', requireAuth, requireRole('admin'), (req, res) => {
  res.json({
    message: '这是管理员专属信息',
    adminUser: req.user
  });
});

/**
 * 示例3: 需要 admin 或特定角色才能访问的接口
 * POST /api/protected/sensitive-operation
 */
router.post('/sensitive-operation', requireAuth, requireRole('admin'), (req, res) => {
  const { action } = req.body;
  
  log.info(`[敏感操作] 用户: ${req.user.username}, 操作: ${action}`);
  
  res.json({
    success: true,
    message: `执行操作: ${action}`,
    operator: req.user.username
  });
});

/**
 * 示例4: 多个角色都可以访问的接口
 * GET /api/protected/multi-role
 */
router.get('/multi-role', requireAuth, requireRole('admin', 'moderator'), (req, res) => {
  res.json({
    message: '管理员或版主可以访问',
    yourRole: req.user.role
  });
});

module.exports = router;
