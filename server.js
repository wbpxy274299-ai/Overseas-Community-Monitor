/**
 * DC 发布系统 — Express 服务器入口 (Node.js 版)
 * 路由已拆分至 routes/ 目录，中间件在 middleware/ 目录
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const path = require('path');
const fs = require('fs');
const log = require('./logger');

const { UPLOAD_DIR } = require('./config');
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/api/', globalLimiter);

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ===== 路由挂载 =====
app.use('/', require('./routes/pages'));
app.use('/api/auth', require('./routes/google_auth')); // Google OAuth SSO
app.use('/', require('./routes/dc'));
app.use('/', require('./routes/sentiment'));
app.use('/', require('./routes/admin'));
app.use('/', require('./routes/feedback'));

// ===== 启动 =====
let server = null;

async function start() {
  await db.initDb();

  // 初始化舆情监控数据库表
  try {
    sentiment.initSentimentTable();
    sentiment.initWeeklyReportsTable();
    sentiment.initTopicHistoryTable();
    console.log('✅ 舆情监控模块已初始化');
  } catch (e) {
    console.error('⚠️ 舆情监控模块初始化失败:', e.message);
  }

  log.info('DC 发布 Web 服务启动');
  console.log(`🚀 DC 发布 Web 服务启动 (端口 ${PORT})`);

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
