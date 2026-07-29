/**
 * DC 发布系统 — SQLite 数据库层 (Node.js 版)
 * 使用 sql.js（纯 JS 实现的 SQLite）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');
const { DB_PATH } = require('./config');

let db = null;   // sql.js Database 实例

// ===== 初始化数据库 =====
async function initDb() {
  const SQL = await initSqlJs();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  // 建表
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      request_type  TEXT NOT NULL DEFAULT 'send',
      status        TEXT NOT NULL DEFAULT 'received',
      channel_name  TEXT NOT NULL,
      content       TEXT,
      image_urls    TEXT,
      send_time     TEXT,
      actual_time   TEXT,
      message_id    TEXT,
      fail_reason   TEXT,
      sender        TEXT,
      operator      TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
    )
  `);

  // 兼容：旧表可能没有 operator 列
  try { db.run('ALTER TABLE tasks ADD COLUMN operator TEXT'); } catch (_) {}

  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_send_time ON tasks(send_time)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC)');
  
  // 新增复合索引（提升查询性能）
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_channel_status ON tasks(channel_name, status)');

  // 用户表
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'operator',  -- 角色: pending/viewer/operator/admin/super_admin
      email         TEXT,                           -- Google 邮箱
      google_id     TEXT UNIQUE,                    -- Google ID (SSO)
      picture       TEXT,                           -- 头像 URL
      created_at    TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
    )
  `);

  // 兼容：旧表可能没有 role 列
  try { db.run('ALTER TABLE users ADD COLUMN role TEXT DEFAULT "operator"'); } catch (_) {}
  
  // 兼容：添加 Google SSO 相关字段
  try { db.run('ALTER TABLE users ADD COLUMN email TEXT'); } catch (_) {}
  try { db.run('ALTER TABLE users ADD COLUMN google_id TEXT'); } catch (_) {}
  try { db.run('ALTER TABLE users ADD COLUMN picture TEXT'); } catch (_) {}

  // 兼容：添加用户扩展权限列（JSON 格式，存储额外权限和地区限制）
  try { db.run('ALTER TABLE users ADD COLUMN user_permissions TEXT'); } catch (_) {}

  // 数据迁移：旧版 'user' 角色 → 'operator'
  try {
    db.run("UPDATE users SET role = 'operator' WHERE role = 'user'");
  } catch (_) {}
  
  // 数据迁移：将超级管理员邮箱对应的用户设为 super_admin
  try {
    for (const email of SUPER_ADMIN_EMAILS) {
      const user = queryOne('SELECT id, role FROM users WHERE email = ?', [email]);
      if (user && user.role !== 'super_admin') {
        db.run('UPDATE users SET role = ? WHERE email = ?', ['super_admin', email]);
        console.log(`✅ 超级管理员设置: ${email} → super_admin`);
      }
    }
  } catch (_) {}

  // 设置默认管理员（阿饱）
  const adminExists = queryOne('SELECT id FROM users WHERE username = ?', ['阿饱']);
  if (!adminExists) {
    const adminHash = hashPassword('abao123'); // 默认密码，首次登录后修改
    db.run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', 
           ['阿饱', adminHash, 'admin']);
    saveDb();
    console.log('✅ 默认管理员账号已创建: 阿饱 (密码: abao123)');
  }

  // 舆情周报表
  db.run(`
    CREATE TABLE IF NOT EXISTS weekly_reports (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT NOT NULL,
      content       TEXT NOT NULL,
      risk_level    TEXT DEFAULT 'low',
      twitter_count INTEGER DEFAULT 0,
      discord_count INTEGER DEFAULT 0,
      summary       TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
    )
  `);

  // 每日快照表（用于周报快速查询 + 每日與情存档）
  db.run(`
    CREATE TABLE IF NOT EXISTS daily_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date   TEXT NOT NULL UNIQUE,  -- YYYY-MM-DD
      data_json       TEXT NOT NULL,          -- JSON格式的当日所有记录
      record_count    INTEGER DEFAULT 0,
      platforms       TEXT,                   -- 逗号分隔的平台列表
      ai_topics_json  TEXT,                   -- AI热门话题分析结果存档（JSON）
      created_at      TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_daily_snapshots_date ON daily_snapshots(snapshot_date DESC)');

  // 安全添加 ai_topics_json 列（已存在则忽略）
  try { db.run('ALTER TABLE daily_snapshots ADD COLUMN ai_topics_json TEXT'); } catch (_) {}

  // 反馈表
  db.run(`
    CREATE TABLE IF NOT EXISTS feedbacks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user  TEXT NOT NULL,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      status     TEXT DEFAULT 'unread',
      created_at TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON feedbacks(created_at DESC)');

  // DC 采集游标表（记住每个频道追到哪条消息了，实现增量采集）
  db.run(`
    CREATE TABLE IF NOT EXISTS dc_collection_cursor (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id      TEXT NOT NULL UNIQUE,
      channel_name    TEXT,
      server          TEXT NOT NULL DEFAULT 'TC',
      last_message_id TEXT NOT NULL,
      total_collected INTEGER DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
    )
  `);

  saveDb();
  console.log('✅ 数据库初始化完成');
}

// ===== 保存到磁盘 =====
function saveDb() {
  if (!db) return;
  const data = db.export();
  const buf = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buf);
}

// ===== 辅助：把查询结果转成对象数组 =====
function queryAll(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    if (params.length > 0) {
      // sql.js 的 bind 方法需要传入数组
      stmt.bind(params);
    }
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  } catch (e) {
    console.error('❌ 数据库查询错误:', e.message);
    console.error('SQL:', sql);
    console.error('Params:', params);
    throw e;
  }
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// 执行不返回结果的 SQL（如 DELETE、UPDATE）
function execute(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    if (params.length > 0) {
      stmt.bind(params);
    }
    stmt.step();
    stmt.free();
  } catch (e) {
    console.error('❌ 数据库执行错误:', e.message);
    console.error('SQL:', sql);
    console.error('Params:', params);
    throw e;
  }
}

function nowStr() {
  const d = new Date(); // 直接使用本地时间(CST)
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// ===== 密码（bcrypt 加盐加密） =====
function hashPassword(password) {
  return bcrypt.hashSync(password, 10);  // 10 轮加盐，安全性和速度的平衡点
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);  // 比较密码和哈希值
}

// ===== 用户管理 =====
function createUser(username, password) {
  try {
    db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)',
      [username, hashPassword(password)]);
    saveDb();
    return true;
  } catch (e) {
    return false;   // 用户名已存在
  }
}

function verifyUser(username, password) {
  const row = queryOne('SELECT password_hash FROM users WHERE username = ?', [username]);
  if (!row) return false;
  return verifyPassword(password, row.password_hash);  // bcrypt 比较
}

function userExists(username) {
  const row = queryOne('SELECT 1 FROM users WHERE username = ?', [username]);
  return row !== null;
}

// ===== 有效角色列表 =====
const VALID_ROLES = ['pending', 'viewer', 'operator', 'admin', 'super_admin'];

// 超级管理员邮箱列表
const SUPER_ADMIN_EMAILS = ['wbpxy274299@gmail.com'];

// ===== 用户角色管理 =====
function getUserRole(username) {
  const row = queryOne('SELECT role FROM users WHERE username = ?', [username]);
  return row && VALID_ROLES.includes(row.role) ? row.role : 'pending';
}

function isAdmin(username) {
  return getUserRole(username) === 'admin';
}

function setUserRole(username, role) {
  if (!VALID_ROLES.includes(role)) {
    throw new Error('无效的角色: ' + role);
  }
  db.run('UPDATE users SET role = ? WHERE username = ?', [role, username]);
  saveDb();
}

function getAllUsers() {
  return queryAll('SELECT id, username, role, email, google_id, picture, user_permissions, created_at FROM users ORDER BY created_at DESC');
}

function deleteUser(username) {
  db.run('DELETE FROM users WHERE username = ?', [username]);
  saveDb();
}

// 根据邮箱获取角色（用于登录时实时检查）
function getRoleByEmail(email) {
  const row = queryOne('SELECT role FROM users WHERE email = ?', [email]);
  return row ? row.role : null;
}

// ===== 用户扩展权限管理 =====
// user_permissions 是一个 JSON 字符串，格式如：
// {"upload": true, "regions": ["JP", "TC", "SEA", "KR"]}
// - upload: operator 是否有上传数据权限（默认 false）
// - regions: 可操作的地区列表（默认 null = 全地区，空数组 = 无地区）

const ALL_REGIONS = ['JP', 'TC', 'SEA', 'KR'];

function getUserPermissions(username) {
  const row = queryOne('SELECT user_permissions, role FROM users WHERE username = ?', [username]);
  if (!row) return { upload: false, regions: ALL_REGIONS };
  // admin/super_admin 拥有全部权限
  if (row.role === 'admin' || row.role === 'super_admin') {
    return { upload: true, regions: ALL_REGIONS };
  }
  try {
    const perms = row.user_permissions ? JSON.parse(row.user_permissions) : {};
    return {
      upload: !!perms.upload,
      regions: perms.regions || ALL_REGIONS, // null 或 undefined 表示全地区
    };
  } catch (_) {
    return { upload: false, regions: ALL_REGIONS };
  }
}

function setUserPermissions(username, permissions) {
  const json = JSON.stringify(permissions);
  db.run('UPDATE users SET user_permissions = ? WHERE username = ?', [json, username]);
  saveDb();
}

function hasUploadPermission(username) {
  return getUserPermissions(username).upload;
}

function hasRegionAccess(username, server) {
  const perms = getUserPermissions(username);
  return perms.regions.includes(server);
}

// ===== Google SSO 用户管理 =====
function getUserByGoogleId(googleId) {
  return queryOne('SELECT * FROM users WHERE google_id = ?', [googleId]);
}

function getUserByEmail(email) {
  return queryOne('SELECT * FROM users WHERE email = ?', [email]);
}

function createUserWithGoogle(username, email, googleId, password, role = 'pending') {
  try {
    db.run(
      'INSERT INTO users (username, password_hash, email, google_id, role) VALUES (?, ?, ?, ?, ?)',
      [username, hashPassword(password), email, googleId, role]
    );
    saveDb();
    return queryOne('SELECT * FROM users WHERE google_id = ?', [googleId]);
  } catch (e) {
    console.error('创建 Google 用户失败:', e.message);
    return null;
  }
}

function updateUserGoogleInfo(userId, googleId, email, picture) {
  db.run(
    'UPDATE users SET google_id = ?, email = ?, picture = ? WHERE id = ?',
    [googleId, email, picture, userId]
  );
  saveDb();
}

function setUserRoleByGoogleId(googleId, role) {
  if (!VALID_ROLES.includes(role)) {
    throw new Error('无效的角色: ' + role);
  }
  db.run('UPDATE users SET role = ? WHERE google_id = ?', [role, googleId]);
  saveDb();
}

// ===== 任务管理 =====
function createTask(data) {
  const cols = ['request_type', 'status', 'channel_name', 'content',
                'image_urls', 'send_time', 'sender', 'operator', 'message_id'];
  const vals = cols.map(c => data[c] || '');
  if (!vals[0]) vals[0] = 'send';
  if (!vals[1]) vals[1] = 'received';

  const placeholders = cols.map(() => '?').join(',');
  db.run(`INSERT INTO tasks (${cols.join(',')}) VALUES (${placeholders})`, vals);

  const result = db.exec('SELECT last_insert_rowid() AS id');
  const id = result[0].values[0][0];
  saveDb();
  return typeof id === 'bigint' ? Number(id) : id;
}

function updateTask(taskId, fields) {
  if (!fields || Object.keys(fields).length === 0) return;
  const now = nowStr();
  fields.updated_at = now;

  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(taskId);
  db.run(`UPDATE tasks SET ${sets.join(',')} WHERE id = ?`, vals);
  saveDb();
}

function getTask(taskId) {
  return queryOne('SELECT * FROM tasks WHERE id = ?', [taskId]);
}

function listTasks({ status, channelName, requestType, search, page = 1, perPage = 50 } = {}) {
  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (channelName) { conditions.push('channel_name = ?'); params.push(channelName); }
  if (requestType) { conditions.push('request_type = ?'); params.push(requestType); }
  if (search) {
    conditions.push('(content LIKE ? OR channel_name LIKE ? OR operator LIKE ? OR image_urls LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * perPage;
  params.push(perPage, offset);
  return queryAll(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, params);
}

function getPendingTasks() {
  return queryAll("SELECT * FROM tasks WHERE status IN ('received','scheduled') ORDER BY created_at ASC");
}

function countTasks(status) {
  let row;
  if (status) {
    row = queryOne('SELECT COUNT(*) AS cnt FROM tasks WHERE status = ?', [status]);
  } else {
    row = queryOne('SELECT COUNT(*) AS cnt FROM tasks');
  }
  return row ? row.cnt : 0;
}

function getDb() { return db; }

// ===== DC 采集游标：记住每个频道追到哪了 =====
function getCollectionCursor(channelId, server) {
  const row = queryOne(
    'SELECT last_message_id, total_collected FROM dc_collection_cursor WHERE channel_id = ? AND server = ?',
    [channelId, server]
  );
  return row;
}

function updateCollectionCursor(channelId, server, channelName, messageId, totalCollected) {
  const now = nowStr();
  const existing = queryOne('SELECT id FROM dc_collection_cursor WHERE channel_id = ? AND server = ?', [channelId, server]);
  if (existing) {
    db.run(
      'UPDATE dc_collection_cursor SET last_message_id = ?, channel_name = ?, total_collected = ?, updated_at = ? WHERE channel_id = ? AND server = ?',
      [messageId, channelName, totalCollected, now, channelId, server]
    );
  } else {
    db.run(
      'INSERT INTO dc_collection_cursor (channel_id, channel_name, server, last_message_id, total_collected, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [channelId, channelName, server, messageId, totalCollected, now]
    );
  }
  saveDb();
}

module.exports = {
  initDb, saveDb, queryAll, queryOne,
  createUser, verifyUser, userExists,
  getUserRole, isAdmin, setUserRole, getAllUsers, VALID_ROLES, SUPER_ADMIN_EMAILS,
  deleteUser, getRoleByEmail,
  getUserPermissions, setUserPermissions, hasUploadPermission, hasRegionAccess, ALL_REGIONS,
  getUserByGoogleId, getUserByEmail, createUserWithGoogle, updateUserGoogleInfo, setUserRoleByGoogleId,
  createTask, updateTask, getTask, listTasks,
  getPendingTasks, countTasks,
  getDb, nowStr,
  execute, // 添加 execute 方法
  getCollectionCursor, updateCollectionCursor,
};
