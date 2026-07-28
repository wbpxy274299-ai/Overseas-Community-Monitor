/**
 * 认证与授权中间件
 * - Google OAuth 2.0 SSO 集成
 * - JWT + HttpOnly Cookie 会话管理
 * - 基于角色的访问控制 (RBAC)
 */
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const db = require('../db');
const log = require('../logger');

// ===== JWT 配置 =====
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-me-in-production';
const JWT_EXPIRES_IN = '7d'; // 7 天
const COOKIE_NAME = 'session_token';
const COOKIE_MAX_AGE = 7 * 24 * 3600 * 1000; // 7 天（毫秒）

// ===== Google OAuth 客户端（懒加载）=====
let oauth2Client = null;

function getOAuth2Client() {
  if (!oauth2Client) {
    oauth2Client = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_CALLBACK_URL || 'http://localhost:5000/api/auth/google/callback'
    );
  }
  return oauth2Client;
}

// ===== JWT 工具函数 =====

/**
 * 签发 JWT 并写入 HttpOnly Cookie
 */
function issueSession(res, userData) {
  const payload = {
    userId: userData.userId,
    username: userData.username,
    email: userData.email,
    role: userData.role,
    googleId: userData.googleId,
    picture: userData.picture,
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,       // JS 无法读取，防 XSS
    secure: false,        // 本地开发用 HTTP；生产环境改 true
    sameSite: 'lax',      // 防 CSRF
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });

  return token;
}

/**
 * 从 Cookie 中读取并验证 JWT
 * @returns {Object|null} 解码后的 payload，失败返回 null
 */
function verifySessionFromCookie(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ===== Google 用户信息获取 =====

async function getGoogleUserInfo(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Google API 错误: ${response.status}`);
  const info = await response.json();
  return {
    googleId: info.sub,
    email: info.email,
    name: info.name,
    picture: info.picture,
    emailVerified: info.email_verified,
  };
}

// ===== 创建/查找本地用户并签发会话 =====

async function createSession(googleUserInfo) {
  let localUser = db.getUserByGoogleId(googleUserInfo.googleId);

  if (!localUser) {
    // 新用户自动注册
    const username = googleUserInfo.name || googleUserInfo.email.split('@')[0];
    const defaultPassword = Math.random().toString(36).slice(-8);
    localUser = db.createUserWithGoogle(
      username, googleUserInfo.email, googleUserInfo.googleId, defaultPassword, 'user'
    );
    log.info(`[新用户注册] ${username} (${googleUserInfo.email})`);
  } else {
    log.info(`[老用户登录] ${localUser.username}`);
  }

  return {
    userId: localUser.id,
    username: localUser.username,
    email: googleUserInfo.email,
    role: localUser.role,
    googleId: googleUserInfo.googleId,
    picture: googleUserInfo.picture,
  };
}

// ===== 认证中间件 =====

/**
 * requireAuth——验证请求是否携带有效 JWT Cookie
 * 验证通过后，将用户信息挂载到 req.user
 */
function requireAuth(req, res, next) {
  const user = verifySessionFromCookie(req);
  if (!user) {
    return res.status(401).json({
      error: '未授权',
      message: '请先登录',
      code: 'UNAUTHORIZED',
    });
  }
  req.user = user;
  next();
}

/**
 * requireRole(...roles)——检查用户角色是否在允许列表中
 * 必须先经过 requireAuth
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: '未授权', message: '请先登录', code: 'UNAUTHORIZED' });
    }
    if (!roles.includes(req.user.role)) {
      log.warn(`[权限拒绝] 用户: ${req.user.username}, 角色: ${req.user.role}, 需要: ${roles.join(',')}`);
      return res.status(403).json({
        error: '权限不足',
        message: `需要以下角色之一: ${roles.join(', ')}`,
        code: 'FORBIDDEN',
        requiredRoles: roles,
        currentRole: req.user.role,
      });
    }
    next();
  };
}

/**
 * optionalAuth——如果已登录则附加用户信息，否则继续（不拦截）
 */
function optionalAuth(req, res, next) {
  const user = verifySessionFromCookie(req);
  if (user) req.user = user;
  next();
}

// ===== 页面认证中间件（非 API 路由用）=====

/**
 * ensureLoggedIn——页面路由专用，未登录重定向到 /login
 */
function ensureLoggedIn(req, res, next) {
  const user = verifySessionFromCookie(req);
  if (!user) {
    res.clearCookie(COOKIE_NAME);
    return res.redirect('/login');
  }
  req.user = user;
  next();
}

// ===== 辅助函数 =====

function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// 保留兼容旧代码的导出
function clearUserCache() { /* JWT 无状态，无需清缓存 */ }
function forceLogout(googleId) { /* 保留接口兼容 */ }

module.exports = {
  // OAuth
  getOAuth2Client,
  getGoogleUserInfo,
  createSession,
  // JWT + Cookie
  issueSession,
  verifySessionFromCookie,
  clearSession,
  // 中间件
  requireAuth,
  requireRole,
  optionalAuth,
  ensureLoggedIn,
  // 兼容旧接口
  clearUserCache,
  forceLogout,
  // 常量
  JWT_SECRET,
  COOKIE_NAME,
};
