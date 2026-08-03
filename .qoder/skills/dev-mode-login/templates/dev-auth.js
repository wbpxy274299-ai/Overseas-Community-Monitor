/**
 * 本地开发模式登录（绕过第三方 OAuth）
 * ⚠️ 此文件必须在 .gitignore 中排除，不会推送到生产服务器
 * 
 * 使用方式：在 server.js 中条件加载
 *   if (process.env.NODE_ENV !== 'production') {
 *     app.use(require('./routes/dev-auth'));
 *   }
 */
const express = require('express');
const router = express.Router();

// ===== 根据项目实际情况修改以下 import =====
const db = require('../db');
const { issueSession, clearSession } = require('../middleware/auth');

// ===== 预设角色（根据项目权限体系调整） =====
const DEV_USERS = {
  super_admin: {
    googleId: 'dev-superadmin-000',
    username: '开发超管',
    email: 'dev-super@test.com',
    role: 'super_admin',
    picture: '',
  },
  admin: {
    googleId: 'dev-admin-001',
    username: '开发管理员',
    email: 'dev-admin@test.com',
    role: 'admin',
    picture: '',
  },
  operator: {
    googleId: 'dev-operator-002',
    username: '开发运营员',
    email: 'dev-operator@test.com',
    role: 'operator',
    picture: '',
  },
  viewer: {
    googleId: 'dev-viewer-003',
    username: '开发查看者',
    email: 'dev-viewer@test.com',
    role: 'viewer',
    picture: '',
  },
  pending: {
    googleId: 'dev-pending-004',
    username: '开发待审批',
    email: 'dev-pending@test.com',
    role: 'pending',
    picture: '',
  },
};

// ===== 角色描述（修改此处匹配你的项目） =====
const ROLE_DESCRIPTIONS = {
  super_admin: { icon: '🌟', name: '超级管理员 (super_admin)', desc: '最高权限：全部功能' },
  admin: { icon: '👑', name: '管理员 (admin)', desc: '管理权限：数据管理 + 审核' },
  operator: { icon: '⚙️', name: '运营员 (operator)', desc: '运营权限：内容管理 + 只读报表' },
  viewer: { icon: '👁️', name: '查看者 (viewer)', desc: '只读权限：查看数据' },
  pending: { icon: '⏳', name: '待审批 (pending)', desc: '无权限：等待管理员审批' },
};

// ===== 开发登录页面 =====
router.get('/login', (req, res) => {
  const buttons = Object.entries(ROLE_DESCRIPTIONS)
    .map(([role, info]) => `<a href="/dev-login/${role}" class="role-btn">
      <span class="icon">${info.icon}</span>
      <span class="name">${info.name}</span>
      <span class="desc">${info.desc}</span>
    </a>`)
    .join('\n    ');

  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>本地开发登录</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-card {
      background: white;
      border-radius: 16px;
      padding: 40px;
      max-width: 420px;
      width: 90%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .banner {
      background: #fff3cd;
      border: 1px solid #ffc107;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 24px;
      text-align: center;
      font-size: 13px;
      color: #856404;
    }
    h1 { text-align: center; margin-bottom: 8px; font-size: 22px; }
    .subtitle { text-align: center; color: #666; margin-bottom: 24px; font-size: 14px; }
    .role-btn {
      display: block;
      width: 100%;
      padding: 16px 20px;
      margin: 12px 0;
      border: 2px solid #e2e8f0;
      border-radius: 12px;
      background: white;
      cursor: pointer;
      font-size: 15px;
      text-align: left;
      transition: all 0.2s;
      text-decoration: none;
      color: #1a202c;
    }
    .role-btn:hover {
      border-color: #667eea;
      background: #f7fafc;
      transform: translateX(4px);
    }
    .role-btn .icon { font-size: 24px; margin-right: 12px; }
    .role-btn .name { font-weight: 600; }
    .role-btn .desc { display: block; font-size: 12px; color: #718096; margin-top: 4px; margin-left: 36px; }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="banner">⚠️ 本地开发模式 — 此页面不会出现在生产环境</div>
    <h1>🔧 选择角色登录</h1>
    <p class="subtitle">点击即以对应角色身份登录系统</p>
    ${buttons}
  </div>
</body>
</html>`);
});

// ===== 以指定角色登录 =====
router.get('/dev-login/:role', (req, res) => {
  const { role } = req.params;
  const devUser = DEV_USERS[role];
  if (!devUser) {
    return res.status(400).send('无效角色，可选: ' + Object.keys(DEV_USERS).join(' / '));
  }

  // 确保 DB 中存在该用户
  let localUser = db.getUserByGoogleId(devUser.googleId);
  if (!localUser) {
    localUser = db.createUserWithGoogle(
      devUser.username, devUser.email, devUser.googleId,
      Math.random().toString(36).slice(-8), devUser.role
    );
  } else if (localUser.role !== devUser.role) {
    db.setUserRole(localUser.username, devUser.role);
  }

  // 签发 JWT Cookie
  issueSession(res, {
    userId: localUser.id,
    username: devUser.username,
    email: devUser.email,
    role: devUser.role,
    googleId: devUser.googleId,
    picture: devUser.picture,
  });

  // 低权限角色跳转让用户看到"无权限"页面
  if (role === 'viewer' || role === 'pending') {
    return res.redirect('/');
  }
  res.redirect('/');
});

// ===== 登出 =====
router.get('/dev-logout', (req, res) => {
  clearSession(res);
  res.redirect('/login');
});

module.exports = router;
