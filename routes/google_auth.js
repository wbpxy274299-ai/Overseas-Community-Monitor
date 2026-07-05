/**
 * Google OAuth 2.0 SSO 认证路由
 */
const express = require('express');
const router = express.Router();
const { getOAuth2Client, getGoogleUserInfo, createSession, clearUserCache } = require('../middleware/auth');
const log = require('../logger');

/**
 * 生成 Google OAuth 授权 URL
 * GET /api/auth/google/login
 */
router.get('/google/login', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
  ];
  
  const oauth2Client = getOAuth2Client();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent' // 始终显示同意页面，确保获取 refresh token
  });
  
  log.info('[Google OAuth] 生成授权 URL');
  res.json({ authUrl });
});

/**
 * Google OAuth 回调处理
 * GET /api/auth/google/callback?code=AUTHORIZATION_CODE
 */
router.get('/google/callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.status(400).json({
      error: '缺少授权码',
      message: '请从登录页面重新发起请求'
    });
  }
  
  try {
    // 1. 使用授权码换取 Token
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    log.info('[Google OAuth] Token 交换成功');
    
    // 2. 获取用户信息
    const userInfo = await getGoogleUserInfo(tokens.access_token);
    log.info(`[Google OAuth] 获取用户信息: ${userInfo.email}`);
    
    // 3. 创建或更新会话（带缓存）
    const session = await createSession(userInfo);
    
    // 4. 返回会话 Token（前端存储）
    res.json({
      success: true,
      token: session.googleId, // 简化：直接使用 googleId 作为 token
      user: {
        id: session.userId,
        username: session.username,
        email: session.email,
        role: session.role,
        picture: session.picture
      },
      expiresIn: 86400000 // 24小时
    });
    
  } catch (error) {
    log.error('[Google OAuth] 认证失败:', error.message);
    res.status(500).json({
      error: 'Google 认证失败',
      message: error.message
    });
  }
});

/**
 * 验证 Token 并获取用户信息
 * POST /api/auth/verify
 */
router.post('/verify', async (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({
      error: '缺少 Token'
    });
  }
  
  try {
    const { authCache } = require('./auth');
    const cacheKey = `session:${token}`;
    const session = authCache.get(cacheKey);
    
    if (!session) {
      return res.status(401).json({
        error: '会话已过期',
        message: '请重新登录'
      });
    }
    
    // 检查是否过期
    if (new Date(session.expiresAt) < new Date()) {
      authCache.del(cacheKey);
      return res.status(401).json({
        error: '会话已过期',
        message: '请重新登录'
      });
    }
    
    res.json({
      valid: true,
      user: {
        id: session.userId,
        username: session.username,
        email: session.email,
        role: session.role,
        picture: session.picture
      }
    });
    
  } catch (error) {
    log.error('[Token 验证] 失败:', error.message);
    res.status(500).json({
      error: '验证失败'
    });
  }
});

/**
 * 登出（清除缓存）
 * POST /api/auth/logout
 */
router.post('/logout', (req, res) => {
  const { token } = req.body;
  
  if (token) {
    clearUserCache(token);
    log.info(`[登出] Token: ${token.substring(0, 8)}...`);
  }
  
  res.json({
    success: true,
    message: '已登出'
  });
});

module.exports = router;
