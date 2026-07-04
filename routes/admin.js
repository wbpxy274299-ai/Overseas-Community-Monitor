/**
 * 权限管理路由
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const log = require('../logger');

// 获取所有用户列表（仅管理员）
router.get('/api/admin/users', (req, res) => {
  const operator = decodeURIComponent(req.headers['x-operator'] || '');
  if (!operator || !db.isAdmin(operator)) {
    return res.status(403).json({ error: '权限不足，需要管理员权限' });
  }
  try {
    const users = db.getAllUsers();
    res.json({ ok: true, data: users });
  } catch (e) {
    log.error('获取用户列表失败', e.message);
    res.status(500).json({ error: `获取失败: ${e.message}` });
  }
});

// 设置用户角色（仅管理员）
router.put('/api/admin/users/:username/role', (req, res) => {
  const operator = decodeURIComponent(req.headers['x-operator'] || '');
  if (!operator || !db.isAdmin(operator)) {
    return res.status(403).json({ error: '权限不足，需要管理员权限' });
  }
  try {
    const { username } = req.params;
    const { role } = req.body;
    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({ error: '无效的角色' });
    }
    if (!db.userExists(username)) {
      return res.status(404).json({ error: '用户不存在' });
    }
    db.setUserRole(username, role);
    log.info(`管理员 ${operator} 将用户 ${username} 的角色设置为 ${role}`);
    res.json({ ok: true, message: '角色更新成功' });
  } catch (e) {
    log.error('设置用户角色失败', e.message);
    res.status(500).json({ error: `设置失败: ${e.message}` });
  }
});

module.exports = router;
