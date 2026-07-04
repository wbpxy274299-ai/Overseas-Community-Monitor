/**
 * 请求频率限制配置
 */
const rateLimit = require('express-rate-limit');

// 登录/注册：同一 IP 15 分钟内最多 10 次
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: '尝试太多次了，请 15 分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 全局：每个 IP 1 分钟最多 60 次
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: '请求太频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { authLimiter, globalLimiter };
