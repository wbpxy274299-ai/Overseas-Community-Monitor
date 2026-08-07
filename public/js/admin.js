/**
 * 权限管理 — 页面逻辑
 * 使用 JWT Cookie 认证，服务端校验角色
 * 支持 5 级角色: pending / viewer / operator / admin / super_admin
 */
const API_BASE = '/api/admin';

const ROLE_LABELS = {
  pending:     { icon: '⏳', name: '待审批', desc: '无权限，等待管理员审批' },
  viewer:      { icon: '👁️', name: '查看者', desc: '只能查看舆情、术语、反馈' },
  operator:    { icon: '⚙️', name: '运营员', desc: 'DC发布 + 舆情/周报/历史(只读)' },
  admin:       { icon: '👑', name: '管理员', desc: '全部权限（除玩家洞察/删用户）' },
  super_admin: { icon: '🌟', name: '超级管理员', desc: '最高权限，含删用户/玩家洞察' },
};

// 获取当前用户
function getCurrentUser() {
  return JSON.parse(localStorage.getItem('user') || 'null');
}

// 加载用户列表
async function loadUsers() {
  const user = getCurrentUser();
  if (!user) {
    window.location.href = '/login';
    return;
  }
  try {
    const response = await fetch(`${API_BASE}/users`, {
      credentials: 'same-origin'
    });
    if (response.status === 401 || response.status === 403) {
      Toast.error('❌ 权限不足或会话已过期');
      setTimeout(() => { window.location.href = '/login'; }, 2000);
      return;
    }
    const data = await response.json();
    if (data.ok) {
      renderUserTable(data.data);
    } else {
      Toast.error('❌ 加载失败: ' + data.error);
    }
  } catch (error) {
    console.error('加载用户列表失败:', error);
    Toast.error('❌ 网络错误');
  }
}

// 渲染用户表格
function renderUserTable(users) {
  const tbody = document.getElementById('userTableBody');
  if (!users || users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">暂无用户</td></tr>';
    return;
  }
  // 更新计数角标
  const cntEl = document.getElementById('cntUsers');
  if (cntEl) cntEl.textContent = users.length + ' 人';

  const currentUser = getCurrentUser();
  const isSuperAdmin = currentUser && currentUser.role === 'super_admin';

  // 🎯 关键过滤：非超管看不到 super_admin 用户（完全隐藏，不是置灰）
  const filteredUsers = isSuperAdmin ? users : users.filter(u => u.role !== 'super_admin');

  let html = '';
  for (const user of filteredUsers) {
    const role = user.role || 'operator';
    const roleInfo = ROLE_LABELS[role] || ROLE_LABELS.operator;
    const roleBadgeClass = {
      super_admin: 'badge-danger',
      admin: 'badge-admin',
      operator: 'badge-success',
      viewer: 'badge-info',
      pending: 'badge-muted',
    }[role] || 'badge-info';
    const roleBadge = `<span class="badge ${roleBadgeClass}">${roleInfo.icon} ${roleInfo.name}</span>`;

    // 构建角色选择器（排除当前角色）
    const isSelf = currentUser && user.username === currentUser.name;
    const roleSelector = buildRoleSelector(user.username, role, isSelf);
    const deleteBtn = isSuperAdmin && !isSelf
      ? `<button class="btn btn-op danger btn-sm" style="margin-top:4px;" onclick="deleteUser('${escapeHtml(user.username)}')">🗑️ 删除</button>`
      : '';

    // 构建扩展权限控件（仅 operator 显示，admin/super_admin 默认全权限）
    const permsHtml = buildPermissionsCell(user);

    html += `
      <tr>
        <td>
          <strong>${escapeHtml(user.username)}</strong>
          ${user.email ? `<br><small style="color:var(--mut);">${escapeHtml(user.email)}</small>` : ''}
          ${isSelf ? '<span class="badge badge-info" style="margin-left:6px;">你</span>' : ''}
        </td>
        <td>${roleBadge}</td>
        <td><small style="color:var(--mut);">${roleInfo.desc}</small></td>
        <td>${permsHtml}</td>
        <td>${formatDate(user.created_at)}</td>
        <td>${roleSelector}<br>${deleteBtn}</td>
      </tr>`;
  }
  
  tbody.innerHTML = html;
}

// 构建角色选择下拉框
function buildRoleSelector(username, currentRole, isSelf) {
  const currentUser = getCurrentUser();
  const isSuperAdmin = currentUser && currentUser.role === 'super_admin';
  // 非超管不能看到/设置 super_admin 角色
  const roles = isSuperAdmin
    ? ['pending', 'viewer', 'operator', 'admin', 'super_admin']
    : ['pending', 'viewer', 'operator', 'admin'];
  let options = roles.map(r => {
    const info = ROLE_LABELS[r];
    const selected = r === currentRole ? 'selected' : '';
    return `<option value="${r}" ${selected}>${info.icon} ${info.name}</option>`;
  }).join('');

  return `
    <select onchange="changeRole('${username}', this.value, this)" 
            ${isSelf ? 'disabled title="不能修改自己的角色"' : ''}
            class="sel" style="padding:6px 10px;border-radius:8px;font-size:12px;min-width:120px;">
      ${options}
    </select>`;
}

// 修改用户角色
async function changeRole(username, newRole, selectEl) {
  const roleInfo = ROLE_LABELS[newRole];
  if (!confirm(`确定要将 ${username} 的角色设置为「${roleInfo.icon} ${roleInfo.name}」吗？`)) {
    // 取消时恢复原来的选择
    const user = getCurrentUser();
    loadUsers(); // 重新加载以恢复
    return;
  }
  try {
    const response = await fetch(`${API_BASE}/users/${encodeURIComponent(username)}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
      credentials: 'same-origin'
    });
    const data = await response.json();
    if (data.ok) {
      Toast.success(`✅ 已将 ${username} 设置为「${roleInfo.icon} ${roleInfo.name}」`);
      loadUsers();
    } else {
      Toast.error('❌ 操作失败: ' + data.error);
      loadUsers(); // 恢复
    }
  } catch (error) {
    console.error('修改角色失败:', error);
    Toast.error('❌ 网络错误');
    loadUsers();
  }
}

// ===== 删除用户（仅超管）=====
async function deleteUser(username) {
  if (!confirm(`确定要删除用户「${username}」吗？此操作不可撤销！`)) return;
  try {
    const res = await fetch(`${API_BASE}/users/${encodeURIComponent(username)}`, {
      method: 'DELETE',
      credentials: 'same-origin'
    });
    const data = await res.json();
    if (data.ok) {
      Toast.success(`✅ 已删除用户 ${username}`);
      loadUsers();
    } else {
      Toast.error('❌ 删除失败: ' + data.error);
    }
  } catch (e) {
    Toast.error('❌ 网络错误');
  }
}

// ===== Tab 切换 =====

// ===== 扩展权限控件 =====
const REGION_LABELS = { JP: '🇯🇵 日服', TC: '🇹🇼 繁中', SEA: '🌏 东南亚', KR: '🇰🇷 韩服' };

function buildPermissionsCell(user) {
  const role = user.role || 'operator';
  // admin/super_admin 默认全权限，不显示控件
  if (role === 'admin' || role === 'super_admin') {
    return '<small style="color:#888;">默认全权限</small>';
  }
  // pending/viewer 不显示扩展权限
  if (role === 'pending' || role === 'viewer') {
    return '<small style="color:#ccc;">—</small>';
  }

  // operator：解析权限
  let perms = {};
  try { perms = user.user_permissions ? JSON.parse(user.user_permissions) : {}; } catch (_) {}
  const hasUpload = !!perms.upload;
  const hasPostAssistant = perms.postAssistant !== false; // 默认 true
  const regions = perms.regions || ['JP', 'TC', 'SEA', 'KR']; // null = 全地区
  const username = escapeHtml(user.username);

  // 上传开关
  const uploadToggle = `
    <label class="perm-toggle" title="是否允许上传舆情数据">
      <input type="checkbox" ${hasUpload ? 'checked' : ''} onchange="togglePerm('${username}', 'upload', this.checked)">
      <span>📤 上传数据</span>
    </label>`;

  // 贴文助手开关
  const postAssistantToggle = `
    <label class="perm-toggle" title="是否允许访问贴文助手（外包运营可关闭）">
      <input type="checkbox" ${hasPostAssistant ? 'checked' : ''} onchange="togglePerm('${username}', 'postAssistant', this.checked)">
      <span>✍️ 贴文助手</span>
    </label>`;

  // 地区复选框
  const regionChecks = Object.entries(REGION_LABELS).map(([key, label]) => {
    const checked = regions.includes(key) ? 'checked' : '';
    return `<label class="region-check">
      <input type="checkbox" ${checked} onchange="togglePerm('${username}', 'region_${key}', this.checked)">
      <span>${label}</span>
    </label>`;
  }).join('');

  return `<div class="perm-cell">${uploadToggle}${postAssistantToggle}<div class="region-row">${regionChecks}</div></div>`;
}

// 切换权限
async function togglePerm(username, type, value) {
  try {
    // 先获取当前权限
    const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}/permissions`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.ok) { Toast.error('获取权限失败'); return; }

    const perms = data.data;
    if (type === 'upload') {
      perms.upload = value;
    } else if (type === 'postAssistant') {
      perms.postAssistant = value;
    } else if (type.startsWith('region_')) {
      const region = type.replace('region_', '');
      if (value) {
        if (!perms.regions.includes(region)) perms.regions.push(region);
      } else {
        perms.regions = perms.regions.filter(r => r !== region);
      }
    }

    // 保存
    const saveRes = await fetch(`/api/admin/users/${encodeURIComponent(username)}/permissions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(perms),
      credentials: 'same-origin',
    });
    const saveData = await saveRes.json();
    if (saveData.ok) {
      const label = type === 'upload' ? '上传权限' : type === 'postAssistant' ? '贴文助手' : type.replace('region_', '') + ' 地区';
      Toast.success(`✅ ${username} 的 ${label} 已${value ? '开通' : '关闭'}`);
    } else {
      Toast.error('❌ 保存失败: ' + saveData.error);
      loadUsers(); // 回滚 UI
    }
  } catch (e) {
    Toast.error('❌ 网络错误');
    loadUsers();
  }
}

// ===== Tab 切换 =====
function switchTab(tab) {
  document.querySelectorAll('.tab-card').forEach(t => t.classList.remove('on'));
  document.querySelectorAll('.adm-pane').forEach(c => c.classList.remove('on'));
  if (event && event.target) {
    const card = event.target.closest('.tab-card');
    if (card) card.classList.add('on');
  }
  document.getElementById('tab-' + tab).classList.add('on');
  // 切换时加载数据
  if (tab === 'feedback') loadFeedback();
  if (tab === 'database') loadDbOverview();
  if (tab === 'publish') { loadTokens(); }
}

// ===== Token 管理 =====
async function loadTokens() {
  try {
    const res = await fetch('/api/admin/tokens', { credentials: 'same-origin' });
    const data = await res.json();
    if (data.ok) renderTokenCards(data.data);
    else Toast.error('加载 Token 失败');
  } catch (e) { Toast.error('网络错误'); }
}

function renderTokenCards(tokens) {
  const container = document.getElementById('tokenCards');
  const user = getCurrentUser();
  const isSuperAdmin = user && user.role === 'super_admin';
  // 更新计数角标
  const cntEl = document.getElementById('cntPublish');
  if (cntEl) cntEl.textContent = tokens.length + ' Token';
  container.innerHTML = tokens.map(t => {
    const editBtnHtml = isSuperAdmin
      ? `<button class="btn-token-edit" onclick="showTokenEdit('${t.server}')">✏️ 更新 Token</button>`
      : `<button class="btn-token-edit" disabled title="仅超级管理员可更新 Token" style="opacity:0.4;cursor:not-allowed;">✏️ 更新 Token</button>`;
    return `
    <div class="tok-card" id="token-card-${t.server}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="strong">${t.label}</span>
        <span class="tag ${t.has ? 'ok' : 'err'}">${t.has ? '已配置' : '未配置'}</span>
      </div>
      <div class="tok-mask"><code>${t.masked}</code></div>
      ${t.length ? `<div style="font-size:11px;color:var(--mut)">Token 长度: ${t.length}</div>` : ''}
      <div id="token-result-${t.server}"></div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn-op" onclick="testToken('${t.server}')">🔍 测试健康度</button>
        ${editBtnHtml}
      </div>
      <div class="token-edit-form" id="token-edit-${t.server}" style="display:none;">
        <input type="password" id="token-input-${t.server}" placeholder="粘贴新的 Token" class="sel" style="width:100%;margin-top:8px">
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-solid btn-sm" onclick="saveToken('${t.server}')">💾 保存</button>
          <button class="btn btn-ghost btn-sm" onclick="hideTokenEdit('${t.server}')">取消</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

async function testToken(server) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '⏳ 测试中...';
  const resultEl = document.getElementById('token-result-' + server);
  resultEl.innerHTML = '<span class="testing">正在连接 Discord API...</span>';
  try {
    const res = await fetch('/api/admin/tokens/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server }),
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (data.ok && data.status === 'healthy') {
      resultEl.innerHTML = `<span class="test-ok">✅ ${data.message}</span>`;
    } else if (data.ok && data.status === 'identity_only') {
      resultEl.innerHTML = `<span class="test-warn">⚠️ ${data.message}</span>`;
    } else {
      resultEl.innerHTML = `<span class="test-fail">❌ ${data.message}</span>`;
    }
  } catch (e) {
    resultEl.innerHTML = `<span class="test-fail">❌ 网络错误</span>`;
  }
  btn.disabled = false;
  btn.textContent = '🔍 测试健康度';
}

function showTokenEdit(server) {
  document.getElementById('token-edit-' + server).style.display = 'block';
  document.getElementById('token-input-' + server).focus();
}
function hideTokenEdit(server) {
  document.getElementById('token-edit-' + server).style.display = 'none';
  document.getElementById('token-input-' + server).value = '';
}

async function saveToken(server) {
  const input = document.getElementById('token-input-' + server);
  const token = input.value.trim();
  if (!token || token.length < 20) { Toast.warning('Token 格式不正确'); return; }
  if (!confirm('确定要更新 ' + server + ' 的 Token？')) return;
  try {
    const res = await fetch('/api/admin/tokens/' + server, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (data.ok) {
      Toast.success(data.message);
      hideTokenEdit(server);
      loadTokens();
    } else {
      Toast.error(data.error);
    }
  } catch (e) { Toast.error('网络错误'); }
}

// ===== DC 频道管理 =====
async function loadChannels() {
  try {
    const res = await fetch('/api/admin/channels', { credentials: 'same-origin' });
    const data = await res.json();
    if (data.ok) renderChannelList(data.data);
    else Toast.error('加载频道失败');
  } catch (e) { Toast.error('网络错误'); }
}

function renderChannelList(channels) {
  const container = document.getElementById('channelList');
  if (!channels.length) { container.innerHTML = '<div class="empty-state">暂无频道</div>'; return; }
  // 按 Bot 分组
  const groups = {};
  for (const ch of channels) {
    if (!groups[ch.bot]) groups[ch.bot] = [];
    groups[ch.bot].push(ch);
  }
  const botLabels = { TC: '繁中服', JP: '日服', SEA: '东南亚服', KR: '韩服' };
  let html = '';
  for (const [bot, list] of Object.entries(groups)) {
    html += `<div class="micro" style="margin:18px 0 12px;color:var(--info)">${botLabels[bot] || bot} (${list.length})</div>`;
    for (const ch of list) {
      html += `<div class="ch-row">
        <span class="strong" style="font-size:13px">${escapeHtml(ch.name)}</span>
        <span class="cid">${ch.channel_id}</span>
        <span class="del"><button class="btn-op danger" onclick="deleteChannel('${encodeURIComponent(ch.name)}')" title="删除">🗑️</button></span>
      </div>`;
    }
  }
  container.innerHTML = html;
}

async function addChannel() {
  const name = document.getElementById('newChName').value.trim();
  const bot = document.getElementById('newChBot').value;
  const channel_id = document.getElementById('newChId').value.trim();
  if (!name || !bot || !channel_id) { Toast.warning('请填写所有字段'); return; }
  if (!/^\d{15,20}$/.test(channel_id)) { Toast.warning('频道 ID 格式不正确，应为15-20位数字'); return; }
  try {
    const res = await fetch('/api/admin/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, bot, channel_id }),
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (data.ok) {
      Toast.success('频道已添加');
      document.getElementById('newChName').value = '';
      document.getElementById('newChId').value = '';
      document.getElementById('newChBot').value = '';
      loadChannels();
    } else {
      Toast.error(data.error);
    }
  } catch (e) { Toast.error('网络错误'); }
}

async function deleteChannel(encodedName) {
  if (!confirm('确定要删除这个频道吗？')) return;
  try {
    const res = await fetch('/api/admin/channels/' + encodedName, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (data.ok) { Toast.success('频道已删除'); loadChannels(); }
    else Toast.error(data.error);
  } catch (e) { Toast.error('网络错误'); }
}

// ===== 意见反馈（仅超管） =====
async function loadFeedback() {
  const user = getCurrentUser();
  if (!user || user.role !== 'super_admin') {
    document.getElementById('feedbackList').innerHTML = '<div class="empty-state">权限不足</div>';
    return;
  }
  try {
    const res = await fetch('/api/feedback', { credentials: 'same-origin' });
    const data = await res.json();
    if (data.ok) renderFeedbackList(data.data);
    else Toast.error('加载反馈失败');
  } catch (e) { Toast.error('网络错误'); }
}

function renderFeedbackList(items) {
  const container = document.getElementById('feedbackList');
  if (!items || !items.length) {
    container.innerHTML = '<div class="empty-state" style="padding:32px;text-align:center;color:var(--mut);">暂无反馈 ✨</div>';
    return;
  }
  // 更新计数角标
  const unreadCount = items.filter(i => i.status === 'unread').length;
  const cntEl = document.getElementById('cntFeedback');
  if (cntEl) cntEl.textContent = unreadCount + ' 未读';
  const statusLabels = { unread: '未读', read: '已读', resolved: '已处理' };
  container.innerHTML = items.map(item => {
    const statusText = statusLabels[item.status] || item.status;
    const statusTagClass = item.status === 'unread' ? 'warn' : item.status === 'resolved' ? 'ok' : 'info';
    const date = item.created_at ? formatTimestamp(item.created_at) : '—';
    return `
    <div class="fb-card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
        <span class="strong" style="font-size:14px">${escapeHtml(item.title)}</span>
        <span class="tag ${statusTagClass}">${statusText}</span>
      </div>
      <div style="font-size:11px;color:var(--mut);margin-top:6px">👤 ${escapeHtml(item.from_user || '匿名')} · 📅 ${date}</div>
      <div class="fb-body">${escapeHtml(item.content)}</div>
      <div style="display:flex;gap:8px">
        ${item.status === 'unread' ? `<button class="btn-op" onclick="markFeedbackRead(${item.id})">标为已读</button>` : ''}
        ${item.status !== 'resolved' ? `<button class="btn-op ok" onclick="markFeedbackResolved(${item.id})">标为已处理</button>` : ''}
        <button class="btn-op danger" onclick="deleteFeedback(${item.id})">🗑️ 删除</button>
      </div>
    </div>`;
  }).join('');
}

async function markFeedbackRead(id) {
  try {
    const res = await fetch(`/api/feedback/${id}/status`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'read' }), credentials: 'same-origin',
    });
    const data = await res.json();
    if (data.ok) { Toast.success('已标为已读'); loadFeedback(); }
    else Toast.error('操作失败');
  } catch (e) { Toast.error('网络错误'); }
}

async function markFeedbackResolved(id) {
  try {
    const res = await fetch(`/api/feedback/${id}/status`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }), credentials: 'same-origin',
    });
    const data = await res.json();
    if (data.ok) { Toast.success('已标为已处理'); loadFeedback(); }
    else Toast.error('操作失败');
  } catch (e) { Toast.error('网络错误'); }
}

async function deleteFeedback(id) {
  if (!confirm('确定删除这条反馈吗？')) return;
  try {
    const res = await fetch(`/api/feedback/${id}`, {
      method: 'DELETE', credentials: 'same-origin',
    });
    const data = await res.json();
    if (data.ok) { Toast.success('已删除'); loadFeedback(); }
    else Toast.error('删除失败');
  } catch (e) { Toast.error('网络错误'); }
}

// ===== 数据库管理 =====
let dbState = { table: null, page: 1, search: '', columns: [] };

async function loadDbOverview() {
  showDbOverview();
  try {
    const [statsRes, tablesRes] = await Promise.all([
      fetch('/api/admin/db/stats', { credentials: 'same-origin' }),
      fetch('/api/admin/db/tables', { credentials: 'same-origin' }),
    ]);
    const stats = await statsRes.json();
    const tables = await tablesRes.json();
    
    if (stats.ok) {
      document.getElementById('dbStatsBar').innerHTML = `
        <span class="db-stat-item">💾 文件大小: <strong>${stats.data.fileSizeHuman}</strong></span>
        <span class="db-stat-item">📊 表数: <strong>${stats.data.totalTables}</strong></span>
        <span class="db-stat-item">📝 总行数: <strong>${stats.data.totalRows.toLocaleString()}</strong></span>
      `;
    }
    
    if (tables.ok) {
      renderDbTableGrid(tables.data);
    }
  } catch (e) {
    document.getElementById('dbTableGrid').innerHTML = '<div class="empty-state">加载失败: ' + e.message + '</div>';
  }
}

function renderDbTableGrid(tables) {
  const grid = document.getElementById('dbTableGrid');
  if (!tables.length) { grid.innerHTML = '<div class="empty-state">无可管理的表</div>'; return; }
  
  const ICONS = {
    sentiment_records: '舆', lounge_posts: 'KR', lounge_comments: '评',
    lounge_daily_reports: '日', topic_history: '话', daily_snapshots: '快',
    feedbacks: '反', insights_reports: '洞', weekly_reports: '周',
  };
  
  // 更新计数角标
  const cntEl = document.getElementById('cntDb');
  if (cntEl) cntEl.textContent = tables.length + ' 表';
  
  grid.innerHTML = tables.map(t => {
    const icon = ICONS[t.name] || t.name.charAt(0).toUpperCase();
    const timeStr = t.latestAt ? formatTimestamp(t.latestAt) : '—';
    return `
    <div class="db-card" onclick="openDbTable('${t.name}', '${escapeHtml(t.label)}')">
      <div class="b">${icon}</div>
      <div>
        <div class="n">${escapeHtml(t.label)}</div>
        <div class="t">${t.name} · ${timeStr}</div>
      </div>
      <div class="r">
        <div class="rn" style="color:${t.rows === 0 ? 'var(--err)' : t.rows > 1000 ? 'var(--ok)' : 'var(--ink)'}">${t.rows.toLocaleString()} 行</div>
      </div>
    </div>`;
  }).join('');
}

function showDbOverview() {
  document.getElementById('db-overview').style.display = '';
  document.getElementById('db-detail').style.display = 'none';
  dbState.table = null;
}

async function openDbTable(tableName, label) {
  dbState.table = tableName;
  dbState.page = 1;
  dbState.search = '';
  document.getElementById('dbSearchInput').value = '';
  document.getElementById('db-overview').style.display = 'none';
  document.getElementById('db-detail').style.display = '';
  document.getElementById('dbDetailTitle').textContent = label || tableName;
  await loadTableData();
}

async function loadTableData() {
  if (!dbState.table) return;
  const tbody = document.getElementById('dbTableBody');
  tbody.innerHTML = '<tr><td class="loading">加载中...</td></tr>';
  
  try {
    const params = new URLSearchParams({ page: dbState.page, size: 50 });
    if (dbState.search) params.set('search', dbState.search);
    
    const res = await fetch(`/api/admin/db/tables/${dbState.table}?${params}`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.ok) { tbody.innerHTML = `<tr><td class="empty-state">加载失败: ${data.error}</td></tr>`; return; }
    
    dbState.columns = data.data.columns || [];
    renderDbTable(data.data);
    renderDbPagination(data.data.pagination);
  } catch (e) {
    tbody.innerHTML = `<tr><td class="empty-state">网络错误: ${e.message}</td></tr>`;
  }
}

function renderDbTable(data) {
  const thead = document.getElementById('dbTableHead');
  const tbody = document.getElementById('dbTableBody');
  const cols = data.columns || [];
  const rows = data.rows || [];
  const pk = cols.find(c => c.pk)?.name || 'id';
  
  // 表头
  const showCols = cols.filter(c => !['content', 'content_zh', 'data_json', 'ai_topics_json', 'picture'].includes(c.name));
  thead.innerHTML = '<tr>' +
    '<th><input type="checkbox" onchange="toggleAllDbRows(this)"></th>' +
    showCols.map(c => `<th title="${c.type}">${c.name}</th>`).join('') +
    '<th>操作</th></tr>';
  
  // 表体
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${showCols.length + 2}" class="empty-state">暂无数据</td></tr>`;
    return;
  }
  
  tbody.innerHTML = rows.map(row => {
    const id = row[pk];
    const cells = showCols.map(c => {
      let val = row[c.name];
      if (val === null || val === undefined) return '<td class="db-cell-null">NULL</td>';
      val = String(val);
      if (val.length > 80) val = val.substring(0, 80) + '...';
      return `<td title="${escapeHtml(val)}">${escapeHtml(val)}</td>`;
    }).join('');
    
    const isLoungePost = dbState.table === 'lounge_posts';
    const actions = [
      `<button class="btn-db-action btn-edit" onclick="editDbRecord(${id})">✏️</button>`,
      `<button class="btn-db-action btn-del" onclick="deleteDbRecord(${id})">🗑️</button>`,
      isLoungePost ? `<button class="btn-db-action btn-recrawl" onclick="recrawlDbPost('${row.post_id || ''}')" title="重爬">🔄</button>` : '',
    ].join('');
    
    return `<tr><td><input type="checkbox" class="db-row-check" value="${id}" onchange="updateBatchCount()"></td>${cells}<td>${actions}</td></tr>`;
  }).join('');
}

function renderDbPagination(pg) {
  const el = document.getElementById('dbPagination');
  if (!pg || pg.totalPages <= 1) { el.innerHTML = ''; return; }
  let html = '';
  if (pg.page > 1) html += `<button onclick="goDbPage(${pg.page - 1})">« 上一页</button>`;
  html += `<span>第 ${pg.page} / ${pg.totalPages} 页 (${pg.total} 条)</span>`;
  if (pg.page < pg.totalPages) html += `<button onclick="goDbPage(${pg.page + 1})">下一页 »</button>`;
  el.innerHTML = html;
}

function goDbPage(page) { dbState.page = page; loadTableData(); }
function doDbSearch() { dbState.search = document.getElementById('dbSearchInput').value.trim(); dbState.page = 1; loadTableData(); }
function refreshDbTable() { loadTableData(); }

function toggleAllDbRows(masterCb) {
  document.querySelectorAll('.db-row-check').forEach(cb => { cb.checked = masterCb.checked; });
  updateBatchCount();
}

function updateBatchCount() {
  const checked = document.querySelectorAll('.db-row-check:checked').length;
  const btn = document.getElementById('btnBatchDel');
  document.getElementById('batchCount').textContent = checked;
  btn.style.display = checked > 0 ? '' : 'none';
}

async function editDbRecord(id) {
  try {
    const res = await fetch(`/api/admin/db/tables/${dbState.table}/${id}`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.ok) { Toast.error('加载失败: ' + data.error); return; }
    
    const row = data.data;
    const cols = dbState.columns;
    const pk = cols.find(c => c.pk)?.name || 'id';
    
    document.getElementById('dbEditTitle').textContent = `编辑 ${dbState.table} #${id}`;
    document.getElementById('dbEditBody').innerHTML = cols.map(c => {
      const val = row[c.name] ?? '';
      const isPk = c.pk;
      const isLong = c.type && c.type.toUpperCase().includes('TEXT') && String(val).length > 100;
      if (isPk) {
        return `<div class="db-edit-field"><label>${c.name} (主键)</label><input type="text" value="${escapeHtml(String(val))}" disabled></div>`;
      }
      if (isLong) {
        return `<div class="db-edit-field"><label>${c.name}</label><textarea rows="4" data-col="${c.name}">${escapeHtml(String(val))}</textarea></div>`;
      }
      return `<div class="db-edit-field"><label>${c.name}</label><input type="text" data-col="${c.name}" value="${escapeHtml(String(val))}"></div>`;
    }).join('');
    
    document.getElementById('dbEditModal').style.display = '';
    document.getElementById('dbEditModal').dataset.id = id;
  } catch (e) {
    Toast.error('网络错误: ' + e.message);
  }
}

function closeDbEditModal() {
  document.getElementById('dbEditModal').style.display = 'none';
}

async function saveDbEdit() {
  const id = document.getElementById('dbEditModal').dataset.id;
  const fields = {};
  document.querySelectorAll('#dbEditBody [data-col]').forEach(el => {
    fields[el.dataset.col] = el.value;
  });
  
  try {
    const res = await fetch(`/api/admin/db/tables/${dbState.table}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (data.ok) {
      Toast.success('更新成功');
      closeDbEditModal();
      loadTableData();
    } else {
      Toast.error('更新失败: ' + data.error);
    }
  } catch (e) {
    Toast.error('网络错误: ' + e.message);
  }
}

async function deleteDbRecord(id) {
  if (!confirm(`确定要删除这条记录吗？`)) return;
  try {
    const res = await fetch(`/api/admin/db/tables/${dbState.table}/${id}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (data.ok) {
      Toast.success('已删除');
      loadTableData();
    } else {
      Toast.error('删除失败: ' + data.error);
    }
  } catch (e) {
    Toast.error('网络错误: ' + e.message);
  }
}

async function batchDeleteSelected() {
  const ids = Array.from(document.querySelectorAll('.db-row-check:checked')).map(cb => parseInt(cb.value));
  if (!ids.length) return;
  if (!confirm(`确定要删除选中的 ${ids.length} 条记录吗？此操作不可撤销！`)) return;
  
  try {
    const res = await fetch(`/api/admin/db/tables/${dbState.table}/batch-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (data.ok) {
      Toast.success(data.message);
      loadTableData();
    } else {
      Toast.error('删除失败: ' + data.error);
    }
  } catch (e) {
    Toast.error('网络错误: ' + e.message);
  }
}

async function recrawlDbPost(postId) {
  if (!postId) { Toast.warning('帖子无 ID'); return; }
  if (!confirm(`确定要重新爬取帖子 ${postId} 吗？`)) return;
  
  try {
    const res = await fetch(`/api/admin/db/recrawl/${postId}`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (data.ok) {
      Toast.success(data.message);
    } else {
      Toast.error('重爬失败: ' + data.error);
    }
  } catch (e) {
    Toast.error('网络错误: ' + e.message);
  }
}

// 页面加载时初始化
window.addEventListener('DOMContentLoaded', () => {
  const user = getCurrentUser();
  if (!user) {
    window.location.href = '/login';
    return;
  }
  console.log('🔐 权限管理页面 - 当前用户:', user.name, '角色:', user.role);
  loadUsers();
  // 仅超管显示反馈 Tab
  if (user.role === 'super_admin') {
    const fbBtn = document.getElementById('feedbackTabBtn');
    if (fbBtn) fbBtn.style.display = '';
  }
  // 如果 URL hash 是 #database，自动切换到数据库管理 Tab
  if (location.hash === '#database') {
    const dbTabBtn = document.querySelector('.admin-tab[onclick*="database"]');
    if (dbTabBtn) {
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
      dbTabBtn.classList.add('active');
      document.getElementById('tab-database').classList.add('active');
      loadDbOverview();
    }
  }
});
