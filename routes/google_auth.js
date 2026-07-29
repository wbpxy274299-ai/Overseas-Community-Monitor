/**
 * Google OAuth 2.0 SSO 认证路由
 * JWT + HttpOnly Cookie 模式
 */
const express = require('express');
const router = express.Router();
const {
  getOAuth2Client,
  getGoogleUserInfo,
  createSession,
  issueSession,
  clearSession,
  verifySessionFromCookie,
  JWT_SECRET,
} = require('../middleware/auth');
const log = require('../logger');

/**
 * 生成 Google OAuth 授权 URL
 * GET /api/auth/google/login
 */
router.get('/google/login', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ];
  const oauth2Client = getOAuth2Client();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
  });
  res.json({ authUrl });
});

/**
 * Google OAuth 回调处理
 * GET /api/auth/google/callback?code=AUTHORIZATION_CODE
 * 成功后签 JWT → 写 HttpOnly Cookie → 重定向到首页
 */
router.get('/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('缺少授权码，请从登录页面重新发起');
  }

  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const userInfo = await getGoogleUserInfo(tokens.access_token);
    log.info(`[Google OAuth] 用户: ${userInfo.email}`);

    const session = await createSession(userInfo);

    // 签发 JWT 并写入 HttpOnly Cookie
    issueSession(res, session);

    // 重定向到首页
    res.redirect('/');
  } catch (error) {
    log.error('[Google OAuth] 认证失败:', error.message);
    res.redirect('/login?error=' + encodeURIComponent('Google 认证失败: ' + error.message));
  }
});

/**
 * 验证 Token 并获取用户信息（前端 checkAuth 调用）
 * GET /api/auth/verify
 */
router.get('/verify', (req, res) => {
  const user = verifySessionFromCookie(req);
  if (!user) {
    return res.status(401).json({ valid: false, error: '会话已过期', code: 'SESSION_EXPIRED' });
  }
  // 实时从数据库刷新角色
  let perms = null;
  try {
    const db = require('../db');
    const currentRole = db.getUserRole(user.username);
    if (currentRole && currentRole !== user.role) {
      user.role = currentRole;
    }
    perms = db.getUserPermissions(user.username);
  } catch (_) {}
  res.json({
    valid: true,
    user: {
      id: user.userId,
      username: user.username,
      email: user.email,
      role: user.role,
      picture: user.picture,
    },
    permissions: perms,
  });
});

/**
 * 登出
 * GET /api/auth/logout
 */
router.get('/logout', (req, res) => {
  clearSession(res);
  log.info(`[登出] 用户已退出`);
  res.redirect('/login');
});

module.exports = router;
