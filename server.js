/**
 * DC 发布系统 — Express 服务器入口 (Node.js 版)
 * 路由已拆分至 routes/ 目录，中间件在 middleware/ 目录
 */
// ★ 统一时区为 UTC+8（与数据库 datetime('now','+8 hours') 一致）
// 这样 new Date() / getHours() 等方法直接返回北京时间，不再需要手动偏移
process.env.TZ = 'Asia/Shanghai';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const path = require('path');
const fs = require('fs');
const log = require('./logger');

const { UPLOAD_DIR, fmtCST8 } = require('./config');
const db = require('./db');
const sentiment = require('./sentiment');
const scheduler = require('./scheduler');
const { daemonLoop } = require('./scanner');
const { globalLimiter } = require('./middleware/rateLimit');

// ===== 全局异常处理（防止进程崩溃）=====
process.on('unhandledRejection', (reason, promise) => {
  console.error('\n❌ [未处理的Promise拒绝]');
  console.error('原因:', reason);
  if (reason instanceof Error) console.error('堆栈:', reason.stack);
  log.error('Unhandled Rejection', reason?.stack || String(reason));
});

process.on('uncaughtException', (error) => {
  console.error('\n❌ [未捕获的异常]');
  console.error('错误:', error.message);
  console.error('堆栈:', error.stack);
  log.error('Uncaught Exception', error.stack);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

const app = express();
const PORT = 5000;

// ===== 全局中间件 =====
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(require('cookie-parser')());
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/static', express.static(path.join(__dirname, 'public')));
// ★ 浏览器默认会自动找 /favicon.ico，指路到静态图标，避免 404 导致页签空白
app.get('/favicon.ico', (req, res) => res.redirect('/static/favicon-fire-spirit.png'));
app.use('/api/', globalLimiter);

// 🚫 Pending 用户拦截：只针对页面路由（HTML 请求），API 请求返回 403 JSON
app.use((req, res, next) => {
  // ★ 登录/登出路径放行：否则拿着待审批 Cookie 的人连切换角色的登录页都进不去（死循环）
  if (/^\/(login|dev-login|dev-logout|google-login)/.test(req.path)) return next();
  // 只拦截 HTML 页面请求（不接受 application/json 的请求头）
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    const cookie = req.cookies && req.cookies['session_token'];
    if (cookie) {
      try {
        const jwt = require('jsonwebtoken');
        const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-me-in-production';
        const decoded = jwt.verify(cookie, JWT_SECRET);
        
        // ★ 去数据库查最新角色（防止 JWT 缓存旧角色，和 requireAuth 保持一致）
        let currentRole = decoded.role;
        try {
          const db = require('./db');
          const dbRole = db.getUserRole(decoded.username);
          if (dbRole) currentRole = dbRole;
        } catch (_) {}
        
        // 🔴 如果是 pending 用户，直接返回 403 错误（不渲染任何页面）
        if (currentRole === 'pending') {
          return res.status(403).send(`
            <!DOCTYPE html>
            <html lang="zh">
            <head>
              <meta charset="UTF-8">
              <title>403 禁止访问</title>
              <style>
                body {
                  margin: 0;
                  padding: 0;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  min-height: 100vh;
                  background: #f8f9fa;
                  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                }
                .error-container {
                  text-align: center;
                  padding: 40px;
                }
                .error-code {
                  font-size: 120px;
                  font-weight: 700;
                  color: #6c757d;
                  margin: 0;
                }
                .error-title {
                  font-size: 24px;
                  font-weight: 600;
                  color: #333;
                  margin: 20px 0;
                }
                .error-desc {
                  font-size: 16px;
                  color: #666;
                  line-height: 1.6;
                  max-width: 400px;
                  margin: 0 auto 30px;
                }
                .error-info {
                  background: #fff3cd;
                  border: 1px solid #ffc107;
                  border-radius: 8px;
                  padding: 16px;
                  max-width: 400px;
                  margin: 0 auto;
                  font-size: 14px;
                  color: #856404;
                }
              </style>
            </head>
            <body>
              <div class="error-container">
                <h1 class="error-code">403</h1>
                <p class="error-title">账号待审批 · 暂时无法访问</p>
                <p class="error-desc">
                  您的账号尚未通过管理员审批，系统已限制访问权限。
                  <br><br>
                  <strong>👉 操作指引：</strong><br>
                  请前往阿里钉，将您的 <strong>Gmail 地址</strong> 发送给 <strong>阿饱同学</strong> 申请开通权限。
                </p>
                <div class="error-info">
                  ⚠️ 提交后请等待管理员审批完成，通常会在 24 小时内处理。
                </div>
              </div>
            </body>
            </html>
          `);
        }
      } catch (e) {
        // JWT 验证失败，继续正常流程（可能未登录）
      }
    }
  }
  next();
});

// 📊 访问记录中间件（记录所有 HTML/API 请求）
app.use((req, res, next) => {
  // 忽略静态资源（CSS/JS/图片等）
  if (req.path.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff2?)$/i)) {
    return next();
  }
  
  try {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const user_agent = req.headers['user-agent'] || '';
    const path = req.path;
    const method = req.method;
    
    // 获取登录用户名（如果有）
    let username = null;
    const cookie = req.cookies && req.cookies['session_token'];
    if (cookie) {
      try {
        const jwt = require('jsonwebtoken');
        const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-me-in-production';
        const decoded = jwt.verify(cookie, JWT_SECRET);
        username = decoded.username || null;
      } catch (e) {}
    }
    
    // 异步记录（不阻塞响应）
    db.logAccess({ ip, user_agent, username, path, method });
  } catch (e) {
    console.error('❌ [访问记录失败]', e.message);
  }
  
  next();
});

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ===== 路由挂载 =====
// 本地开发模式：绕过 Google OAuth，直接用角色选择登录（dev-auth.js 已在 .gitignore 中排除）
if (process.env.NODE_ENV !== 'production') {
  try {
    app.use('/', require('./routes/dev-auth'));
    console.log('🔧 开发模式已启用（本地角色登录）');
  } catch (e) { /* dev-auth.js 不存在时忽略 */ }
}
app.use('/', require('./routes/pages'));
app.use('/api/auth', require('./routes/google_auth')); // Google OAuth SSO
app.use('/', require('./routes/dc'));
app.use('/', require('./routes/sentiment'));
app.use('/', require('./routes/admin'));
app.use('/', require('./routes/feedback'));
app.use('/', require('./routes/terminology'));  // 术语搜索/校对 API
app.use('/', require('./routes/lounge'));  // 韩国社区监控

// ===== 健康检查接口（供外部监控使用）=====
app.get('/api/health', (req, res) => {
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: Math.floor(uptime / 3600) + 'h ' + Math.floor((uptime % 3600) / 60) + 'm',
    memory: {
      rss: Math.round(memoryUsage.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
    },
    timestamp: fmtCST8(new Date()),
  });
});

// 初始化术语模块（后台加载10万条术语，供翻译功能使用）
const terminology = require('./terminology');

// ===== 启动 =====
let server = null;

async function start() {
  await db.initDb();
  terminology.init();  // 加载术语库

  // 初始化舆情监控数据库表
  try {
    sentiment.initSentimentTable();
    sentiment.initWeeklyReportsTable();
    sentiment.initTopicHistoryTable();
    console.log('✅ 舆情监控模块已初始化');
  } catch (e) {
    console.error('⚠️ 舆情监控模块初始化失败:', e.message);
  }

  // 初始化韩国社区监控数据表
  try {
    const loungeRoute = require('./routes/lounge');
    loungeRoute.initLoungeTables();
    console.log('✅ 韩国社区监控模块已初始化');
  } catch (e) {
    console.error('⚠️ 韩国社区监控模块初始化失败:', e.message);
  }

  log.info('DC 发布 Web 服务启动');
  console.log(`🚀 DC 发布 Web 服务启动 (端口 ${PORT})`);

  // Bot Token 状态检查
  const { getDiscordToken } = require('./config');
  const tokenStatus = ['TC', 'JP', 'SEA', 'KR'].map(s => {
    const t = getDiscordToken(s);
    return `${s}: ${t ? '✅' : '❌ 未配置'}`;
  }).join(' | ');
  console.log(`🔑 Bot Token: ${tokenStatus}`);

  server = app.listen(PORT, '0.0.0.0');

  // 端口冲突处理
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ 端口 ${PORT} 被占用！正在尝试释放...`);
      console.error('   💡 请手动关闭占用端口的进程：');
      console.error(`      PowerShell: Get-Process -Name node | Stop-Process -Force`);

      const { execSync } = require('child_process');
      try {
        const result = execSync(`netstat -ano | findstr :${PORT} | findstr LISTEN`, { encoding: 'utf-8' });
        const pidMatch = result.match(/\s+(\d+)\s*$/m);
        if (pidMatch && pidMatch[1] !== String(process.pid)) {
          const pid = pidMatch[1];
          console.log(`   🔧 发现占用进程 PID: ${pid}，正在终止...`);
          execSync(`taskkill /F /PID ${pid}`);
          console.log('   ✅ 已终止占用进程，1秒后重试启动...');
          setTimeout(start, 1000);
          return;
        }
      } catch (_) { /* 无法自动释放 */ }
      process.exit(1);
    } else {
      console.error('服务器启动失败:', err.message);
      process.exit(1);
    }
  });

  // 启动扫描守护进程（处理定时发送/取消/撤回）
  console.log('🔄 扫描守护进程已启动（间隔 1 分钟）');
  daemonLoop();

  // 启动舆情监控定时任务（每天早上8:30自动采集）
  scheduler.startScheduler();
}

// ===== 优雅退出：Ctrl+C 时干净关闭服务器 =====
function gracefulShutdown(signal) {
  console.log(`\n🛑 收到 ${signal}，正在优雅关闭服务器...`);
  try { scheduler.stopScheduler(); } catch (_) {}
  if (server) {
    server.close(() => {
      console.log('✅ 服务器已关闭，端口已释放');
      process.exit(0);
    });
    setTimeout(() => {
      console.log('⚠️ 强制退出');
      process.exit(1);
    }, 3000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

start();
