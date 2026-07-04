/**
 * DC 发布系统 — 前端逻辑 (Node.js 优化版)
 * 优化：const/let 替代 var，fetch 替代 XHR，CSS 类替代内联样式
 */

// ===== 全局状态 =====
const state = {
  channelsData: {},
  sendersData: {},
  channelToServer: {},
  uploadedFilenames: [],
  currentOperator: '',
  currentUserRole: 'user', // 用户角色: user/admin
  imageFileList: [],
  selectedRegion: '', // 当前选择的地区
};

// ===== DOM 缓存 =====
const $ = (id) => document.getElementById(id);

// ===== 通用 fetch 封装 =====
async function api(url, options = {}) {
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const data = await resp.json();
  return { ok: resp.ok, status: resp.status, data };
}

// ===== 消息提示 =====
function showMsg(elId, text, type = 'error') {
  $(elId).innerHTML = `<div class="msg msg-${type}">${text}</div>`;
}

// ===== 二次确认弹窗 =====
function showConfirm(title, message, onConfirm) {
  $('confirmTitle').textContent = title;
  $('confirmMessage').textContent = message;
  $('confirmModal').style.display = 'block';
  
  // 移除旧的事件监听器
  const yesBtn = $('confirmYesBtn');
  const noBtn = $('confirmNoBtn');
  const closeBtn = $('closeConfirmBtn');
  
  const newYesBtn = yesBtn.cloneNode(true);
  const newNoBtn = noBtn.cloneNode(true);
  const newCloseBtn = closeBtn.cloneNode(true);
  
  yesBtn.parentNode.replaceChild(newYesBtn, yesBtn);
  noBtn.parentNode.replaceChild(newNoBtn, noBtn);
  closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
  
  // 添加新的事件监听器
  newYesBtn.addEventListener('click', () => {
    $('confirmModal').style.display = 'none';
    onConfirm();
  });
  
  newNoBtn.addEventListener('click', () => {
    $('confirmModal').style.display = 'none';
  });
  
  newCloseBtn.addEventListener('click', () => {
    $('confirmModal').style.display = 'none';
  });
}

$('confirmModal').addEventListener('click', (e) => {
  if (e.target === $('confirmModal')) {
    $('confirmModal').style.display = 'none';
  }
});

// ===== 登录系统 =====
async function handleLogin() {
  const name = $('loginName').value.trim();
  const password = $('loginPassword').value;
  const btn = $('loginBtn');

  if (!name) return showMsg('loginMsg', '请输入用户名');
  if (!password) return showMsg('loginMsg', '请输入密码');

  btn.disabled = true;
  btn.textContent = '登录中...';
  $('loginMsg').innerHTML = '';

  try {
    const { ok, data } = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ name, password }),
    });
    if (ok) {
      state.currentOperator = name;
      state.currentUserRole = data.role || 'user'; // 保存用户角色
      console.log('✅ 登录成功:', name, '角色:', state.currentUserRole);
      localStorage.setItem('dc_operator', name);
      localStorage.setItem('dc_user_role', state.currentUserRole);
      localStorage.setItem('dc_last_user', name);
      $('loginMsg').innerHTML = '';
      showMainApp();
    } else {
      showMsg('loginMsg', data.error || '登录失败');
    }
  } catch (e) {
    showMsg('loginMsg', '网络错误，请重试');
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
}

// ===== 注册系统 =====
async function handleRegister() {
  const name = $('regName').value.trim();
  const password = $('regPassword').value;
  const confirm = $('regConfirm').value;
  const btn = $('regBtn');

  if (!name) return showMsg('regMsg', '请填写用户名');
  if (!password) return showMsg('regMsg', '请填写密码');
  if (password.length < 4) return showMsg('regMsg', '密码至少4个字符');
  if (password !== confirm) return showMsg('regMsg', '两次密码不一致');

  btn.disabled = true;
  btn.textContent = '注册中...';
  $('regMsg').innerHTML = '';

  try {
    const { ok, data } = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ name, password, confirm }),
    });
    if (ok) {
      showMsg('regMsg', '注册成功！请去登录', 'success');
      $('loginName').value = name;
      setTimeout(() => {
        $('registerForm').style.display = 'none';
        $('loginForm').style.display = 'block';
        $('regMsg').innerHTML = '';
      }, 1500);
    } else {
      showMsg('regMsg', data.error || '注册失败');
    }
  } catch (e) {
    showMsg('regMsg', '网络错误，请重试');
  } finally {
    btn.disabled = false;
    btn.textContent = '注册';
  }
}

function doLogout() {
  state.currentOperator = '';
  localStorage.removeItem('dc_operator');
  showLoginScreen();
}

function showMainApp() {
  $('loginScreen').style.display = 'none';
  $('mainApp').style.display = 'block';
  $('currentOperator').textContent = state.currentOperator;
  
  // 根据角色显示/隐藏功能
  applyRolePermissions();
  
  initMainApp();
}

// ===== 应用角色权限 =====
function applyRolePermissions() {
  const isAdmin = state.currentUserRole === 'admin';
  console.log('🔐 应用权限控制 - 当前用户:', state.currentOperator, '角色:', state.currentUserRole, '是否管理员:', isAdmin);

  // 公共导航权限过滤（common.js 提供）
  if (typeof applyNavPermissions === 'function') applyNavPermissions();

  if (!isAdmin) {
    console.log('⚠️  普通用户模式');
  } else {
    console.log('✅ 管理员模式 - 显示所有功能');
  }
}

function showLoginScreen() {
  $('loginScreen').style.display = 'flex';
  $('mainApp').style.display = 'none';
  const lastUser = localStorage.getItem('dc_last_user');
  if (lastUser) $('loginName').value = lastUser;
}

function autoLogin() {
  const saved = localStorage.getItem('dc_operator');
  const savedRole = localStorage.getItem('dc_user_role');
  if (saved) {
    state.currentOperator = saved;
    state.currentUserRole = savedRole || 'user'; // 加载保存的角色
    showMainApp();
  } else {
    showLoginScreen();
  }
}

// ===== 初始化 =====
async function initMainApp() {
  await Promise.all([loadChannels(), loadSenders()]);
  loadTasks();
}

async function loadChannels() {
  const { data } = await api('/api/channels');
  state.channelsData = data.servers;
  state.channelToServer = {};
  for (const [server, names] of Object.entries(data.servers)) {
    for (const name of names) state.channelToServer[name] = server;
  }

  // 填充发送频道下拉（初始为空，等待选择地区）
  const sel = $('channel');
  sel.innerHTML = '<option value="">-- 请先选择地区 --</option>';
  sel.disabled = true;

  // 填充筛选频道下拉（全部频道）
  const filterSel = $('filterChannel');
  filterSel.innerHTML = '<option value="">全部频道</option>';
  for (const names of Object.values(data.servers)) {
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      filterSel.appendChild(opt);
    }
  }
}

// ===== 地区变化 → 联动筛选频道 =====
function onRegionChange() {
  const region = $('serverRegion').value;
  const sel = $('channel');
  state.selectedRegion = region;
  
  if (!region) {
    sel.innerHTML = '<option value="">-- 请先选择地区 --</option>';
    sel.disabled = true;
    $('sender').value = '';
    return;
  }
  
  // 启用频道下拉
  sel.disabled = false;
  
  // 填充该地区的频道
  const labels = { JP: '日服', TC: '繁中服', SEA: '东南亚服', KR: '韩服' };
  const names = state.channelsData[region] || [];
  
  sel.innerHTML = '<option value="">-- 请选择频道 --</option>';
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
}

async function loadSenders() {
  const { data } = await api('/api/senders');
  state.sendersData = data.senders;
}

// ===== Tab 切换 =====
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`.tab-btn[data-tab="${name}"]`).classList.add('active');
  $(`tab-${name}`).classList.add('active');
  if (name === 'list') loadTasks();
}

// ===== 发送模式 =====
function onSendModeChange() {
  const mode = $('sendMode').value;
  const timeGroup = $('sendTimeGroup');
  const submitBtn = $('submitBtn');
  if (mode === 'schedule') {
    timeGroup.style.display = 'block';
    submitBtn.textContent = '定时发送';
    $('sendTime').value = '';
  } else {
    timeGroup.style.display = 'none';
    submitBtn.textContent = '立即发送';
  }
}

// ===== 频道变化 → 自动填发送人 =====
function onChannelChange() {
  const ch = $('channel').value;
  if (!ch) { $('sender').value = ''; return; }
  const server = state.channelToServer[ch];
  $('sender').value = (server && state.sendersData[server]) || '';
}

// ===== 图片压缩（浏览器端 Canvas 压缩） =====
function compressImage(file, maxWidth = 1920, quality = 0.8) {
  return new Promise((resolve) => {
    // 小于 500KB 或不是图片，不压缩
    if (file.size < 500 * 1024 || !file.type.startsWith('image/')) {
      resolve(file);
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        const compressed = new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' });
        resolve(compressed);
      }, 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// ===== 图片上传预览 =====
function previewImages() {
  const input = $('imageFiles');
  for (const f of input.files) state.imageFileList.push(f);
  input.value = '';
  renderImagePreview();
}

function renderImagePreview() {
  const div = $('imagePreview');
  div.innerHTML = '';
  state.imageFileList.forEach((f, i) => {
    const url = URL.createObjectURL(f);
    const sizeStr = f.size < 1024 ? `${f.size} B`
      : f.size < 1048576 ? `${(f.size / 1024).toFixed(1)} KB`
      : `${(f.size / 1048576).toFixed(1)} MB`;
    const ext = f.name.split('.').pop().toUpperCase();
    const card = document.createElement('div');
    card.className = 'img-card';
    card.innerHTML = `
      <div class="img-card-thumb" data-idx="${i}">
        <img src="${url}">
        <div class="zoom-label">点击放大</div>
      </div>
      <div class="img-card-info">
        <div class="filename" title="${f.name}">${f.name}</div>
        <div class="file-meta">${ext} · ${sizeStr}</div>
      </div>
      <div class="img-card-actions">
        ${i > 0 ? `<button data-move="-1" data-idx="${i}">&#9650;</button>` : '<div style="flex:1"></div>'}
        ${i < state.imageFileList.length - 1 ? `<button data-move="1" data-idx="${i}">&#9660;</button>` : '<div style="flex:1"></div>'}
        <button class="btn-del" data-remove="${i}">&#10005;</button>
      </div>`;
    div.appendChild(card);
  });
}

// 图片预览区事件委托
function handlePreviewClick(e) {
  const thumb = e.target.closest('.img-card-thumb');
  if (thumb) {
    const idx = parseInt(thumb.dataset.idx);
    const url = URL.createObjectURL(state.imageFileList[idx]);
    $('imageViewerImg').src = url;
    $('imageViewerModal').style.display = 'block';
    return;
  }
  const moveBtn = e.target.closest('[data-move]');
  if (moveBtn) {
    const idx = parseInt(moveBtn.dataset.idx);
    const dir = parseInt(moveBtn.dataset.move);
    const newIdx = idx + dir;
    if (newIdx >= 0 && newIdx < state.imageFileList.length) {
      [state.imageFileList[idx], state.imageFileList[newIdx]] = [state.imageFileList[newIdx], state.imageFileList[idx]];
      renderImagePreview();
    }
    return;
  }
  const removeBtn = e.target.closest('[data-remove]');
  if (removeBtn) {
    state.imageFileList.splice(parseInt(removeBtn.dataset.remove), 1);
    renderImagePreview();
  }
}

// ===== 提交发送 =====
async function submitSend(e) {
  e.preventDefault();
  const msgDiv = $('sendMsg');
  const channelVal = $('channel').value;
  const contentVal = $('content').value.trim();
  const mode = $('sendMode').value;

  // 前端验证
  if (!channelVal) { showMsg('sendMsg', '请选择频道'); return false; }
  if (!contentVal && state.imageFileList.length === 0 && state.uploadedFilenames.length === 0) {
    showMsg('sendMsg', '请输入消息内容或上传图片'); return false;
  }
  if (mode === 'schedule' && !$('sendTime').value) {
    showMsg('sendMsg', '请设置定时发送时间'); return false;
  }
  
  // 验证定时时间是否在未来
  if (mode === 'schedule' && $('sendTime').value) {
    const selectedTime = new Date($('sendTime').value);
    const now = new Date();
    if (selectedTime <= now) {
      showMsg('sendMsg', '定时时间必须是将来的时间'); return false;
    }
  }

  // 压缩并上传图片
  if (state.imageFileList.length > 0) {
    const formData = new FormData();
    for (const f of state.imageFileList) {
      const compressed = await compressImage(f);
      formData.append('files', compressed);
    }
    try {
      const resp = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await resp.json();
      if (resp.ok) {
        state.uploadedFilenames = data.filenames;
      } else {
        showMsg('sendMsg', `图片上传失败: ${data.error}`); return false;
      }
    } catch (err) {
      showMsg('sendMsg', `图片上传网络错误: ${err}`); return false;
    }
  }

  const body = {
    request_type: 'send',
    send_mode: mode,
    channel_name: channelVal,
    content: $('content').value,
    image_urls: state.uploadedFilenames.join(','),
    send_time: mode === 'schedule' ? $('sendTime').value : '',
    sender: $('sender').value,
    operator: state.currentOperator,
  };

  try {
    const { ok, data } = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
    if (ok) {
      const label = data.mode === 'immediate' ? '立即' : '定时';
      showMsg('sendMsg', `${label}发送任务创建成功！ID: ${data.id}`, 'success');
      $('sendForm').reset();
      $('sendMode').value = 'now';
      onSendModeChange();
      state.uploadedFilenames = [];
      state.imageFileList = [];
      $('imagePreview').innerHTML = '';
      $('sender').value = '';
      
      // 自动跳转到任务列表
      setTimeout(() => {
        switchTab('list');
        loadTasks();
      }, 1000);
    } else {
      showMsg('sendMsg', data.error);
    }
  } catch (err) {
    showMsg('sendMsg', `网络错误: ${err}`);
  }
  return false;
}

// ===== 任务列表 =====
async function loadTasks() {
  const status = $('filterStatus').value;
  const channel = $('filterChannel').value;
  const search = $('searchInput').value.trim();
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (channel) params.set('channel', channel);
  if (search) params.set('search', search);

  const { data } = await api(`/api/tasks?${params}`);
  const tbody = $('taskListBody');
  tbody.innerHTML = '';
  $('taskCount').textContent = `共 ${data.total} 条`;

  for (const t of data.tasks) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    const contentShort = (t.content || '').substring(0, 50) || (t.image_urls ? '[图片]' : '—');
    const rtypeLabel = { send: '发送', cancel: '取消', recall: '撤回' }[t.request_type] || t.request_type;
    const sendTimeShort = t.send_time ? t.send_time.replace('T', ' ').substring(0, 16) : '—';
    const actualTimeShort = t.actual_time ? t.actual_time.substring(0, 16) : '—';
    tr.innerHTML = `
      <td><input type="checkbox" class="task-check" data-id="${t.id}"></td>
      <td>${t.id}</td>
      <td>${t.channel_name}</td>
      <td class="content-preview">${contentShort}</td>
      <td>${rtypeLabel}</td>
      <td><span class="status-tag status-${t.status}">${t.status_label}</span></td>
      <td>${sendTimeShort}</td>
      <td>${actualTimeShort}</td>
      <td>${t.sender || '—'}</td>
      <td class="operator-cell">${t.operator || '—'}</td>
      <td class="action-cell">${getActionBtns(t)}</td>`;
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.action-cell')) return;
      showTaskDetail(t);
    });
    tbody.appendChild(tr);
  }

  // 更新批量按钮显示
  updateBatchUI();
}

function getCheckedIds() {
  return [...document.querySelectorAll('.task-check:checked')].map(cb => parseInt(cb.dataset.id));
}

function updateBatchUI() {
  const checked = getCheckedIds();
  $('batchActions').style.display = checked.length > 0 ? 'inline' : 'none';
}

async function batchAction(action) {
  const ids = getCheckedIds();
  if (!ids.length) { alert('请先勾选任务'); return; }
  
  let confirmTitle = '批量操作确认';
  let confirmMessage = '';
  
  if (action === 'cancel') {
    confirmTitle = '确认批量取消';
    confirmMessage = `确定要取消选中的 ${ids.length} 条任务吗？\n\n此操作不可恢复！`;
  } else if (action === 'recall') {
    confirmTitle = '确认批量撤回';
    confirmMessage = `确定要撤回选中的 ${ids.length} 条任务的消息吗？\n\n此操作不可恢复！`;
  } else if (action === 'retry') {
    confirmTitle = '确认批量重试';
    confirmMessage = `确定要重试选中的 ${ids.length} 条任务吗？`;
  }
  
  showConfirm(confirmTitle, confirmMessage, async () => {
    const { ok, data } = await api('/api/tasks/batch', {
      method: 'POST',
      body: JSON.stringify({ task_ids: ids, action, operator: state.currentOperator }),
    });
    if (ok) {
      alert(data.message);
      loadTasks();
    } else {
      alert(data.error);
    }
  });
}

function getActionBtns(t) {
  let btns = '';
  if (['received', 'scheduled'].includes(t.status)) {
    btns += `<button class="btn btn-small btn-danger" data-task="${t.id}" data-action="cancel">取消发送</button>`;
  }
  if (t.status === 'sent' && t.message_id) {
    btns += `<button class="btn btn-small btn-primary" data-preview="${t.id}">DC效果</button>`;
    btns += `<button class="btn btn-small btn-warning" data-task="${t.id}" data-action="recall">撤回消息</button>`;
  }
  if (['failed', 'timeout'].includes(t.status)) {
    btns += `<button class="btn btn-small btn-success" data-task="${t.id}" data-action="retry">重试</button>`;
  }
  return btns || '—';
}

// ===== 任务详情弹窗 =====
function showTaskDetail(t) {
  $('detailTitle').textContent = `任务详情 #${t.id}`;
  const contentHtml = (t.content || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') || '<span style="color:#888;">无内容</span>';

  let imagesHtml = '';
  if (t.image_urls) {
    const urls = t.image_urls.split(',').filter(u => u.trim());
    if (urls.length) {
      imagesHtml = '<div class="detail-images"><strong>图片：</strong><div class="img-grid">';
      for (let url of urls) {
        url = url.trim();
        if (url && !url.startsWith('http')) url = `/uploads/${url}`;
        imagesHtml += `<a href="${url}" target="_blank"><img src="${url}" onerror="this.style.display='none'"></a>`;
      }
      imagesHtml += '</div></div>';
    }
  }

  const rtypeLabel = { send: '发送', cancel: '取消', recall: '撤回' }[t.request_type] || t.request_type;
  const sendTimeShort = t.send_time ? t.send_time.replace('T', ' ').substring(0, 16) : '—';
  const actualTimeShort = t.actual_time ? t.actual_time.substring(0, 19) : '—';

  $('detailBody').innerHTML = `
    <div class="detail-content-box">${contentHtml}</div>
    ${imagesHtml}
    <div class="detail-meta">
      <div><strong>频道：</strong>${t.channel_name}</div>
      <div><strong>类型：</strong>${rtypeLabel}</div>
      <div><strong>状态：</strong>${t.status_label}</div>
      <div><strong>定时时间：</strong>${sendTimeShort}</div>
      <div><strong>实际发送时间：</strong>${actualTimeShort}</div>
      <div><strong>发送人：</strong>${t.sender || '—'}</div>
      <div><strong>操作人：</strong>${t.operator || '—'}</div>
      ${t.fail_reason ? `<div style="color:#e74c3c;"><strong>失败原因：</strong>${t.fail_reason}</div>` : ''}
    </div>`;
  $('taskDetailModal').style.display = 'block';
}

// ===== 操作（取消/撤回/重试）=====
async function doAction(taskId, action, msgDivId) {
  let confirmTitle = '确认操作';
  let confirmMessage = '';
  
  if (action === 'cancel') {
    confirmTitle = '确认取消任务';
    confirmMessage = `确定要取消任务 #${taskId} 吗？\n\n此操作不可恢复！`;
  } else if (action === 'recall') {
    confirmTitle = '确认撤回消息';
    confirmMessage = `确定要撤回任务 #${taskId} 的消息吗？\n\n此操作不可恢复！`;
  } else if (action === 'retry') {
    confirmTitle = '确认重试';
    confirmMessage = `确定要重试任务 #${taskId} 吗？`;
  }
  
  // 显示二次确认弹窗
  showConfirm(confirmTitle, confirmMessage, async () => {
    const { ok, data } = await api(`/api/tasks/${taskId}`, {
      method: 'PUT',
      body: JSON.stringify({ action, operator: state.currentOperator }),
    });
    if (ok) {
      if (msgDivId) {
        showMsg(msgDivId, data.message, 'success');
        lookupTask();
      } else {
        alert(data.message);
      }
      loadTasks();
    } else {
      if (msgDivId) showMsg(msgDivId, data.error);
      else alert(data.error);
    }
  });
}

// ===== 取消/撤回查询 =====
async function lookupTask() {
  const taskId = $('recallTaskId').value;
  if (!taskId) { alert('请输入任务ID'); return; }
  const { ok, data } = await api(`/api/tasks/${taskId}`);
  const detailDiv = $('recallDetail');
  if (!ok) {
    detailDiv.innerHTML = '<div class="msg msg-error">任务不存在</div>';
    return;
  }
  detailDiv.innerHTML = `
    <div class="task-detail-card">
      <div class="detail-row"><span>ID:</span> ${data.id}</div>
      <div class="detail-row"><span>频道:</span> ${data.channel_name}</div>
      <div class="detail-row"><span>内容:</span> ${(data.content || '').substring(0, 80)}</div>
      <div class="detail-row"><span>类型:</span> ${data.request_type}</div>
      <div class="detail-row"><span>状态:</span> <span class="status-tag status-${data.status}">${data.status_label}</span></div>
      <div class="detail-row"><span>定时时间:</span> ${data.send_time || '—'}</div>
      <div class="detail-row"><span>发送人:</span> ${data.sender || '—'}</div>
      <div class="detail-row"><span>操作人:</span> ${data.operator || '—'}</div>
      <div class="detail-row"><span>消息ID:</span> ${data.message_id || '—'}</div>
      <div class="detail-row"><span>失败原因:</span> ${data.fail_reason || '—'}</div>
      <div style="margin-top:10px;">${getRecallBtns(data)}</div>
    </div>`;
}

function getRecallBtns(t) {
  let btns = '';
  if (['received', 'scheduled'].includes(t.status)) {
    btns += `<button class="btn btn-danger" data-task="${t.id}" data-action="cancel" data-msg="recallMsg">取消任务</button>`;
  }
  if (t.status === 'sent' && t.message_id) {
    btns += `<button class="btn btn-warning" data-task="${t.id}" data-action="recall" data-msg="recallMsg">撤回消息</button>`;
  }
  if (['failed', 'timeout'].includes(t.status)) {
    btns += `<button class="btn btn-success" data-task="${t.id}" data-action="retry" data-msg="recallMsg">重试</button>`;
  }
  return btns || '<span style="color:#888;">当前状态无可用操作</span>';
}

// ===== 导出报告 =====
async function exportReport() {
  try {
    const { data } = await api('/api/export');
    const blob = new Blob([data.markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dc-publish-report.md';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('导出失败: ' + err);
  }
}

// ===== Discord Markdown 渲染 =====
function renderDiscordMd(text) {
  if (!text) return '<span style="color:#72767d;">（无文字）</span>';
  // 先转义 HTML
  let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 按行处理
  const lines = s.split('\n');
  const rendered = lines.map(line => {
    // 标题: # / ## / ###
    if (/^### (.+)$/.test(line)) return `<div class="dc-h3">${RegExp.$1}</div>`;
    if (/^## (.+)$/.test(line)) return `<div class="dc-h2">${RegExp.$1}</div>`;
    if (/^# (.+)$/.test(line)) return `<div class="dc-h1">${RegExp.$1}</div>`;
    // 引用: > text
    if (/^&gt; (.+)$/.test(line)) return `<div class="dc-quote">${RegExp.$1}</div>`;
    return line;
  });
  let result = rendered.join('\n');
  // 行内格式
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/\*(.+?)\*/g, '<em>$1</em>');
  result = result.replace(/__(.+?)__/g, '<u>$1</u>');
  result = result.replace(/~~(.+?)~~/g, '<del>$1</del>');
  result = result.replace(/`(.+?)`/g, '<code class="dc-code">$1</code>');
  // 换行转 <br>
  result = result.replace(/\n/g, '<br>');
  return result;
}

// ===== Discord 真实效果预览 =====
async function showDcPreview(taskId) {
  const modal = $('dcPreviewModal');
  const body = $('dcPreviewBody');
  const channelSpan = $('dcPreviewChannel');
  modal.style.display = 'block';
  body.innerHTML = '<div class="dc-loading">⏳ 正在从 Discord 拉取真实消息...</div>';
  channelSpan.textContent = '';

  try {
    const { ok, data } = await api(`/api/tasks/${taskId}/preview`);
    if (!ok) {
      body.innerHTML = `<div class="dc-error">❌ ${data.error || '拉取失败'}</div>`;
      return;
    }
    channelSpan.textContent = data.channel_name;

    // 格式化时间
    const ts = new Date(data.timestamp);
    const timeStr = `${ts.getFullYear()}/${String(ts.getMonth()+1).padStart(2,'0')}/${String(ts.getDate()).padStart(2,'0')} ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}`;

    // 头像
    const avatarHtml = data.author_avatar
      ? `<img src="${data.author_avatar}" alt="avatar">`
      : data.author_name.charAt(0).toUpperCase();

    // 图片
    let imagesHtml = '';
    if (data.images && data.images.length) {
      imagesHtml = '<div class="dc-msg-images">';
      for (const url of data.images) {
        imagesHtml += `<img src="${url}" onclick="document.getElementById('imageViewerImg').src=this.src;document.getElementById('imageViewerModal').style.display='block';">`;
      }
      imagesHtml += '</div>';
    }

    body.innerHTML = `
      <div class="dc-msg">
        <div class="dc-msg-avatar">${avatarHtml}</div>
        <div class="dc-msg-content">
          <div class="dc-msg-header">
            <span class="dc-msg-author">${data.author_name}</span>
            <span class="dc-msg-time">${timeStr}</span>
          </div>
          <div class="dc-msg-text">${renderDiscordMd(data.content)}</div>
          ${imagesHtml}
        </div>
      </div>`;
  } catch (e) {
    body.innerHTML = `<div class="dc-error">❌ 网络错误: ${e}</div>`;
  }
}

// ===== 事件绑定（统一在 DOMContentLoaded） =====
document.addEventListener('DOMContentLoaded', () => {
  // 登录/注册
  $('loginBtn').addEventListener('click', handleLogin);
  $('regBtn').addEventListener('click', handleRegister);
  $('logoutBtn').addEventListener('click', doLogout);
  $('showRegLink').addEventListener('click', () => {
    $('loginForm').style.display = 'none';
    $('registerForm').style.display = 'block';
    $('loginMsg').innerHTML = '';
  });
  $('showLoginLink').addEventListener('click', () => {
    $('registerForm').style.display = 'none';
    $('loginForm').style.display = 'block';
    $('regMsg').innerHTML = '';
  });

  // 回车登录/注册
  $('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
  $('regConfirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleRegister(); });

  // Tab 切换（事件委托）
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (btn) switchTab(btn.dataset.tab);
  });

  // 发送表单
  $('sendForm').addEventListener('submit', submitSend);
  $('sendMode').addEventListener('change', onSendModeChange);
  $('serverRegion').addEventListener('change', onRegionChange); // 新增：地区变化联动
  $('channel').addEventListener('change', onChannelChange);
  $('imageFiles').addEventListener('change', previewImages);
  $('imagePreview').addEventListener('click', handlePreviewClick);

  // 搜索输入（防抖 300ms）
  let searchTimer;
  $('searchInput').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadTasks, 300);
  });

  // 任务列表
  $('filterStatus').addEventListener('change', loadTasks);
  $('filterChannel').addEventListener('change', loadTasks);
  $('refreshBtn').addEventListener('click', loadTasks);

  // 全选
  $('selectAll').addEventListener('change', (e) => {
    document.querySelectorAll('.task-check').forEach(cb => { cb.checked = e.target.checked; });
    updateBatchUI();
  });

  // 复选框变化
  document.getElementById('taskListBody').addEventListener('change', (e) => {
    if (e.target.classList.contains('task-check')) updateBatchUI();
  });

  // 批量操作按钮
  $('batchCancelBtn').addEventListener('click', () => batchAction('cancel'));
  $('batchRecallBtn').addEventListener('click', () => batchAction('recall'));
  $('batchRetryBtn').addEventListener('click', () => batchAction('retry'));
  $('exportBtn').addEventListener('click', exportReport);

  // 弹窗关闭
  $('closeDetailBtn').addEventListener('click', () => { $('taskDetailModal').style.display = 'none'; });
  $('closeViewerBtn').addEventListener('click', () => { $('imageViewerModal').style.display = 'none'; });
  $('taskDetailModal').addEventListener('click', (e) => { if (e.target === $('taskDetailModal')) $('taskDetailModal').style.display = 'none'; });
  $('imageViewerModal').addEventListener('click', (e) => { if (e.target === $('imageViewerModal')) $('imageViewerModal').style.display = 'none'; });
  $('closePreviewBtn').addEventListener('click', () => { $('dcPreviewModal').style.display = 'none'; });
  $('dcPreviewModal').addEventListener('click', (e) => { if (e.target === $('dcPreviewModal')) $('dcPreviewModal').style.display = 'none'; });

  // 操作按钮事件委托（表格和撤回区域）
  document.body.addEventListener('click', (e) => {
    // DC 效果预览按钮
    const previewBtn = e.target.closest('[data-preview]');
    if (previewBtn) {
      e.stopPropagation();
      showDcPreview(parseInt(previewBtn.dataset.preview));
      return;
    }
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      e.stopPropagation();
      const taskId = parseInt(actionBtn.dataset.task);
      const action = actionBtn.dataset.action;
      const msgDiv = actionBtn.dataset.msg || null;
      doAction(taskId, action, msgDiv);
    }
  });

  // 自动刷新列表（每30秒）
  setInterval(() => {
    if ($('mainApp').style.display !== 'none' && $('tab-list').classList.contains('active')) {
      loadTasks();
    }
  }, 30000);

  // 暗黑模式切换
  const savedTheme = localStorage.getItem('dc_theme') || 'light';
  document.body.classList.toggle('dark', savedTheme === 'dark');
  $('themeToggle').textContent = savedTheme === 'dark' ? '☀️' : '🌙';
  $('themeToggle').addEventListener('click', () => {
    const isDark = document.body.classList.toggle('dark');
    localStorage.setItem('dc_theme', isDark ? 'dark' : 'light');
    $('themeToggle').textContent = isDark ? '☀️' : '🌙';
  });

  // 启动
  autoLogin();
});
