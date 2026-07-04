/**
 * DC 发布路由 — 频道/发送人/任务CRUD/图片上传/Discord预览/导出
 */
const express = require('express');
const router = express.Router();

const { CHANNELS, STATUS, SERVER_SENDER, getDiscordToken } = require('../config');
const db = require('../db');
const { sendRecord, fetchMessage, fetchChannel } = require('../scanner');
const log = require('../logger');
const { upload } = require('../middleware/upload');
const { validateInput } = require('../middleware/validate');
const { escapeHtml } = require('../middleware/utils');

// ===== 频道 / 发送人 =====

router.get('/api/senders', (req, res) => {
  res.json({ senders: SERVER_SENDER });
});

router.get('/api/channels', (req, res) => {
  const grouped = {};
  for (const [name, info] of Object.entries(CHANNELS)) {
    const server = info.bot;
    if (!grouped[server]) grouped[server] = [];
    grouped[server].push(name);
  }
  res.json({ servers: grouped });
});

// ===== 图片上传 =====

router.post('/api/upload', upload.array('files', 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '没有上传文件' });
  }
  const filenames = req.files.map(f => f.filename);
  res.json({ filenames });
});

// ===== 任务 CRUD =====

// 新建任务
router.post('/api/tasks', validateInput({
  channel_name: { required: true, type: 'string', maxLength: 100 },
  content: { required: false, type: 'string', maxLength: 5000 },
  image_urls: { required: false, type: 'string', maxLength: 2000 },
  sender: { required: false, type: 'string', maxLength: 50 },
  operator: { required: true, type: 'string', maxLength: 50 },
  request_type: { required: false, type: 'string', maxLength: 20 },
  send_mode: { required: false, type: 'string', maxLength: 20 },
  send_time: { required: false, type: 'string', maxLength: 50 }
}), (req, res) => {
  const {
    channel_name = '', content = '', send_time = '',
    image_urls = '', sender = '', operator = '',
    request_type = 'send', send_mode = 'now',
  } = req.body;

  const ch = escapeHtml(channel_name.trim());
  const ct = escapeHtml(content.trim());
  const st = send_time.trim();
  const iu = image_urls.trim();
  const sd = escapeHtml(sender.trim());
  const op = escapeHtml(operator.trim());
  const rt = request_type.trim();
  const sm = send_mode.trim();

  // 操作人验证
  if (!op) return res.status(401).json({ error: '请先登录（选择操作人身份）' });
  if (!db.userExists(op)) return res.status(401).json({ error: `操作人 '${op}' 未注册` });
  if (!ch) return res.status(400).json({ error: '频道名称不能为空' });
  if (!CHANNELS[ch]) return res.status(400).json({ error: `频道 '${ch}' 不存在` });

  // 发送人自动关联
  let finalSender = sd;
  if (!finalSender) {
    const server = CHANNELS[ch].bot;
    finalSender = SERVER_SENDER[server] || '';
  }

  if (rt === 'send' && !ct && !iu) {
    return res.status(400).json({ error: '消息内容和图片不能同时为空' });
  }

  // ===== 立即发送 =====
  if (sm === 'now' && rt === 'send') {
    const taskId = db.createTask({
      request_type: 'send', status: 'sending',
      channel_name: ch, content: ct, image_urls: iu,
      send_time: '', sender: finalSender, operator: op,
    });

    process.nextTick(() => {
      sendRecord(db.getTask(taskId)).catch(e => {
        log.error(`任务#${taskId} 发送失败: ${e.message}`);
        db.updateTask(taskId, { status: 'failed', fail_reason: e.message });
      });
    });

    return res.status(201).json({ id: taskId, message: '正在立即发送，请稍候查看结果', mode: 'immediate' });
  }

  // ===== 定时发送 / 取消 / 撤回 =====
  if (sm === 'schedule' && rt === 'send' && !st) {
    return res.status(400).json({ error: '定时发送必须填写发送时间' });
  }

  const taskData = {
    request_type: rt, status: 'received',
    channel_name: ch, content: ct, image_urls: iu,
    send_time: st, sender: finalSender, operator: op,
  };

  if (rt === 'cancel' || rt === 'recall') {
    const origId = req.body.original_id;
    if (origId) {
      const orig = db.getTask(parseInt(origId));
      if (orig) taskData.message_id = orig.message_id || '';
    }
  }

  const taskId = db.createTask(taskData);
  log.info(`任务创建: #${taskId} [${rt}] ${ch} by ${op}`);
  res.status(201).json({ id: taskId, message: '任务创建成功', mode: 'scheduled' });
});

// 查询任务列表
router.get('/api/tasks', (req, res) => {
  const status = req.query.status || undefined;
  const channel = req.query.channel || undefined;
  const requestType = req.query.request_type || undefined;
  const search = req.query.search || undefined;
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.per_page) || 50;

  const tasks = db.listTasks({ status, channelName: channel, requestType, search, page, perPage });
  const total = db.countTasks(status);

  for (const t of tasks) {
    t.status_label = STATUS[t.status] || t.status;
  }
  res.json({ tasks, total, page, per_page: perPage });
});

// 查单条任务
router.get('/api/tasks/:id', (req, res) => {
  const task = db.getTask(parseInt(req.params.id));
  if (!task) return res.status(404).json({ error: '任务不存在' });
  task.status_label = STATUS[task.status] || task.status;
  res.json(task);
});

// 更新任务（取消 / 撤回 / 重试）
router.put('/api/tasks/:id', (req, res) => {
  const taskId = parseInt(req.params.id);
  const { action = '', operator = '' } = req.body;
  const act = action.trim();
  const op = operator.trim();
  const task = db.getTask(taskId);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (!op || !db.userExists(op)) return res.status(401).json({ error: '请先登录后再操作' });

  if (act === 'cancel') {
    if (['received', 'scheduled'].includes(task.status)) {
      db.updateTask(taskId, { status: 'cancelled', request_type: 'cancel', operator: op });
      log.info(`任务取消: #${taskId} by ${op}`);
      return res.json({ message: `任务已取消（操作人: ${op})` });
    }
    return res.status(400).json({ error: `当前状态 '${task.status}' 无法取消，请用撤回` });
  }

  if (act === 'recall') {
    if (task.status === 'sent' && task.message_id) {
      db.updateTask(taskId, { status: 'received', request_type: 'recall', operator: op });
      log.info(`撤回请求: #${taskId} by ${op}`);
      return res.json({ message: `撤回请求已提交（操作人: ${op})` });
    }
    return res.status(400).json({ error: `当前状态 '${task.status}' 无法撤回` });
  }

  if (act === 'retry') {
    if (['failed', 'timeout'].includes(task.status)) {
      db.updateTask(taskId, { status: 'received', fail_reason: '', operator: op });
      return res.json({ message: `任务已重置为待处理（操作人: ${op})` });
    }
    return res.status(400).json({ error: `当前状态 '${task.status}' 无法重试` });
  }

  res.status(400).json({ error: '未知操作，支持: cancel / recall / retry' });
});

// 批量操作
router.post('/api/tasks/batch', (req, res) => {
  const { task_ids = [], action = '', operator = '' } = req.body;
  const op = (operator || '').trim();
  if (!op || !db.userExists(op)) return res.status(401).json({ error: '请先登录后再操作' });
  if (!task_ids.length) return res.status(400).json({ error: '没有选择任务' });

  const results = [];
  for (const id of task_ids) {
    const task = db.getTask(parseInt(id));
    if (!task) { results.push({ id, error: '不存在' }); continue; }

    if (action === 'cancel' && ['received', 'scheduled'].includes(task.status)) {
      db.updateTask(id, { status: 'cancelled', request_type: 'cancel', operator: op });
      results.push({ id, ok: true });
    } else if (action === 'recall' && task.status === 'sent' && task.message_id) {
      db.updateTask(id, { status: 'received', request_type: 'recall', operator: op });
      results.push({ id, ok: true });
    } else if (action === 'retry' && ['failed', 'timeout'].includes(task.status)) {
      db.updateTask(id, { status: 'received', fail_reason: '', operator: op });
      results.push({ id, ok: true });
    } else {
      results.push({ id, error: `状态 '${task.status}' 无法${action}` });
    }
  }

  const okCount = results.filter(r => r.ok).length;
  res.json({ message: `成功 ${okCount}/${task_ids.length} 条`, results });
});

// ===== Discord 真实效果预览 =====
router.get('/api/tasks/:id/preview', async (req, res) => {
  try {
    const task = db.getTask(parseInt(req.params.id));
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (task.status !== 'sent' || !task.message_id) {
      return res.status(400).json({ error: '该任务尚未成功发送，无法预览' });
    }

    const channelInfo = CHANNELS[task.channel_name];
    if (!channelInfo) return res.status(400).json({ error: '找不到频道配置' });

    const token = getDiscordToken(channelInfo.bot);
    if (!token) return res.status(400).json({ error: '找不到 Bot Token' });

    const msg = await fetchMessage(channelInfo.channel_id, token, task.message_id);

    let dcChannelName = task.channel_name;
    try {
      const ch = await fetchChannel(channelInfo.channel_id, token);
      if (ch.name) dcChannelName = ch.name;
    } catch (e) { /* 获取失败则用系统名称 */ }

    const images = (msg.attachments || [])
      .filter(a => a.content_type && a.content_type.startsWith('image/'))
      .map(a => a.url || a.proxy_url);

    res.json({
      author_name: msg.author?.username || 'Bot',
      author_avatar: msg.author?.avatar
        ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.png`
        : '',
      content: msg.content || '',
      images,
      timestamp: msg.timestamp,
      channel_name: dcChannelName,
    });
  } catch (e) {
    log.error('预览失败', e.message);
    res.status(500).json({ error: `预览失败: ${e.message}` });
  }
});

// ===== 导出报告 =====
router.get('/api/export', (req, res) => {
  const tasks = db.listTasks({ perPage: 200 });
  const now = db.nowStr();
  let lines = [
    '# DC 发布系统 — 今日报告', '', `生成时间: ${now}`, '',
    `共 ${tasks.length} 条任务`, '', '---', '',
  ];
  for (const t of tasks) {
    const label = STATUS[t.status] || t.status;
    lines.push(`## 任务 #${t.id}  ${label}`);
    lines.push(`- 频道: ${t.channel_name}`);
    lines.push(`- 内容: ${(t.content || '').replace(/\n/g, ' ').slice(0, 100)}`);
    lines.push(`- 图片: ${t.image_urls || '无'}`);
    lines.push(`- 类型: ${t.request_type}`);
    lines.push(`- 定时时间: ${t.send_time || '立即'}`);
    lines.push(`- 发送人(Bot): ${t.sender || '未填'}`);
    lines.push(`- 操作人: ${t.operator || '未填'}`);
    if (t.fail_reason) lines.push(`- 失败原因: ${t.fail_reason}`);
    lines.push('');
  }
  res.json({ markdown: lines.join('\n') });
});

module.exports = router;
