/**
 * 认证与授权中间件
 * - Google OAuth 2.0 SSO 集成
 * - 基于角色的访问控制 (RBAC)
 * - 24小时缓存机制
 */
const NodeCache = require('node-cache');
const { OAuth2Client } = require('google-auth-library');
const db = require('../db');
const log = require('../logger');

// ===== 缓存配置 =====
// 生产环境建议使用 Redis，这里使用内存缓存作为示例
const authCache = new NodeCache({
  stdTTL: 86400, // 24小时（秒）
  checkperiod: 3600, // 每小时检查一次过期
  useClones: false // 不克隆对象，提升性能
});

// ===== Google OAuth 客户端 =====
const oauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_CALLBACK_URL || 'http://localhost:5000/api/auth/google/callback'
);

/**
 * 从 Google Token 获取用户信息
 * @param {string} accessToken - Google Access Token
 * @returns {Promise<Object>} 用户信息
 */
async function getGoogleUserInfo(accessToken) {
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`Google API 错误: ${response.status}`);
    }
    
    const userInfo = await response.json();
    return {
      googleId: userInfo.sub,
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
      emailVerified: userInfo.email_verified
    };
  } catch (error) {
    log.error('获取 Google 用户信息失败:', error.message);
    throw error;
  }
}

/**
 * 验证并缓存用户会话
 * @param {Object} googleUserInfo - Google 用户信息
 * @returns {Promise<Object>} 本地用户会话数据
 */
async function createSession(googleUserInfo) {
  const cacheKey = `session:${googleUserInfo.googleId}`;
  
  // 检查缓存中是否已有该用户的角色信息
  let cachedSession = authCache.get(cacheKey);
  
  if (cachedSession) {
    log.info(`[缓存命中] 用户: ${googleUserInfo.email}`);
    return cachedSession;
  }
  
  // 缓存未命中，从数据库查询或创建用户
  let localUser = db.getUserByGoogleId(googleUserInfo.googleId);
  
  if (!localUser) {
    // 新用户，自动注册
    const username = googleUserInfo.name || googleUserInfo.email.split('@')[0];
    const defaultPassword = Math.random().toString(36).slice(-8); // 随机密码
    
    // 默认角色为 user，管理员需要手动设置
    localUser = db.createUserWithGoogle(
      username,
      googleUserInfo.email,
      googleUserInfo.googleId,
      defaultPassword,
      'user'
    );
    
    log.info(`[新用户注册] ${username} (${googleUserInfo.email})`);
  } else {
    log.info(`[老用户登录] ${localUser.username}`);
  }
  
  // 构建会话对象
  const sessionData = {
    userId: localUser.id,
    username: localUser.username,
    email: googleUserInfo.email,
    role: localUser.role,
    googleId: googleUserInfo.googleId,
    picture: googleUserInfo.picture,
    loginAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString() // 24小时后过期
  };
  
  // 存入缓存（24小时 TTL）
  authCache.set(cacheKey, sessionData);
  
  log.info(`[会话创建] 用户: ${sessionData.username}, 角色: ${sessionData.role}, 缓存TTL: 24h`);
  
  return sessionData;
}

/**
 * 清除用户缓存
 * @param {string} googleId - Google ID
 */
function clearUserCache(googleId) {
  const cacheKey = `session:${googleId}`;
  authCache.del(cacheKey);
  log.info(`[缓存清除] Google ID: ${googleId}`);
}

/**
 * 更新用户角色（同时清除缓存）
 * @param {string} googleId - Google ID
 * @param {string} newRole - 新角色 (admin/user)
 */
function updateUserRole(googleId, newRole) {
  db.setUserRoleByGoogleId(googleId, newRole);
  clearUserCache(googleId);
  log.info(`[角色更新] Google ID: ${googleId}, 新角色: ${newRole}`);
}

/**
 * 认证中间件 - 验证请求是否携带有效 Token
 * 支持两种方式：
 * 1. Session Cookie (传统方式)
 * 2. Bearer Token (API 方式)
 */
function requireAuth(req, res, next) {
  let token = null;
  
  // 优先从 Authorization Header 获取
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }
  
  // 其次从 Cookie 获取
  if (!token && req.cookies && req.cookies.session_token) {
    token = req.cookies.session_token;
  }
  
  if (!token) {
    return res.status(401).json({
      error: '未授权',
      message: '请先登录',
      code: 'UNAUTHORIZED'
    });
  }
  
  // 验证 Token（这里简化处理，实际应使用 JWT）
  // 假设 token 就是 googleId
  const cacheKey = `session:${token}`;
  const session = authCache.get(cacheKey);
  
  if (!session) {
    return res.status(401).json({
      error: '会话已过期',
      message: '请重新登录',
      code: 'SESSION_EXPIRED'
    });
  }
  
  // 检查是否过期
  if (new Date(session.expiresAt) < new Date()) {
    authCache.del(cacheKey);
    return res.status(401).json({
      error: '会话已过期',
      message: '请重新登录',
      code: 'SESSION_EXPIRED'
    });
  }
  
  // 将用户信息附加到 request 对象
  req.user = session;
  next();
}

/**
 * 角色授权中间件 - 检查用户是否具有指定角色
 * @param {...string} roles - 允许的角色列表
 * @returns {Function} Express 中间件
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: '未授权',
        message: '请先登录',
        code: 'UNAUTHORIZED'
      });
    }
    
    if (!roles.includes(req.user.role)) {
      log.warn(`[权限拒绝] 用户: ${req.user.username}, 角色: ${req.user.role}, 需要: ${roles.join(',')}`);
      
      return res.status(403).json({
        error: '权限不足',
        message: `需要以下角色之一: ${roles.join(', ')}`,
        code: 'FORBIDDEN',
        requiredRoles: roles,
        currentRole: req.user.role
      });
    }
    
    next();
  };
}

/**
 * 可选认证中间件 - 如果已登录则附加用户信息，否则继续
 */
function optionalAuth(req, res, next) {
  let token = null;
  
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }
  
  if (!token && req.cookies && req.cookies.session_token) {
    token = req.cookies.session_token;
  }
  
  if (token) {
    const cacheKey = `session:${token}`;
    const session = authCache.get(cacheKey);
    
    if (session && new Date(session.expiresAt) >= new Date()) {
      req.user = session;
    }
  }
  
  next();
}

/**
 * 获取所有活跃会话（用于管理后台）
 */
function getActiveSessions() {
  const keys = authCache.keys();
  const sessions = [];
  
  keys.forEach(key => {
    if (key.startsWith('session:')) {
      const session = authCache.get(key);
      if (session) {
        sessions.push({
          ...session,
          cacheKey: key,
          remainingTTL: authCache.getTtl(key) - Date.now()
        });
      }
    }
  });
  
  return sessions;
}

/**
 * 强制登出用户
 * @param {string} googleId - Google ID
 */
function forceLogout(googleId) {
  clearUserCache(googleId);
  log.info(`[强制登出] Google ID: ${googleId}`);
}

module.exports = {
  oauth2Client,
  getGoogleUserInfo,
  createSession,
  clearUserCache,
  updateUserRole,
  requireAuth,
  requireRole,
  optionalAuth,
  getActiveSessions,
  forceLogout,
  authCache // 导出以便调试
};
