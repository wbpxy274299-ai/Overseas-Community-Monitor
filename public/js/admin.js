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

  const currentUser = getCurrentUser();

  let html = '';
  for (const user of users) {
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
    const isSuperAdmin = currentUser && currentUser.role === 'super_admin';
    const roleSelector = buildRoleSelector(user.username, role, isSelf);
    const deleteBtn = isSuperAdmin && !isSelf
      ? `<button class="btn btn-sm" style="background:var(--color-danger,#f56565);color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer;margin-top:4px;" onclick="deleteUser('${escapeHtml(user.username)}')">🗑️ 删除</button>`
      : '';

    // 构建扩展权限控件（仅 operator 显示，admin/super_admin 默认全权限）
    const permsHtml = buildPermissionsCell(user);

    html += `
      <tr>
        <td>
          <strong>${escapeHtml(user.username)}</strong>
          ${user.email ? `<br><small style="color:var(--color-text-muted,#888);">${escapeHtml(user.email)}</small>` : ''}
          ${isSelf ? '<span class="badge badge-info" style="margin-left:6px;">你</span>' : ''}
        </td>
        <td>${roleBadge}</td>
        <td><small style="color:var(--color-text-secondary,#666);">${roleInfo.desc}</small></td>
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
            style="padding:6px 10px; border-radius:8px; border:1px solid #ddd; font-size:13px; min-width:120px;">
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
  const regions = perms.regions || ['JP', 'TC', 'SEA', 'KR']; // null = 全地区
  const username = escapeHtml(user.username);

  // 上传开关
  const uploadToggle = `
    <label class="perm-toggle" title="是否允许上传舆情数据">
      <input type="checkbox" ${hasUpload ? 'checked' : ''} onchange="togglePerm('${username}', 'upload', this.checked)">
      <span>📤 上传数据</span>
    </label>`;

  // 地区复选框
  const regionChecks = Object.entries(REGION_LABELS).map(([key, label]) => {
    const checked = regions.includes(key) ? 'checked' : '';
    return `<label class="region-check">
      <input type="checkbox" ${checked} onchange="togglePerm('${username}', 'region_${key}', this.checked)">
      <span>${label}</span>
    </label>`;
  }).join('');

  return `<div class="perm-cell">${uploadToggle}<div class="region-row">${regionChecks}</div></div>`;
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
      const label = type === 'upload' ? '上传权限' : type.replace('region_', '') + ' 地区';
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
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('tab-' + tab).classList.add('active');
  // 切换时加载数据
  if (tab === 'tokens') loadTokens();
  if (tab === 'channels') loadChannels();
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
  container.innerHTML = tokens.map(t => `
    <div class="token-card" id="token-card-${t.server}">
      <div class="token-card-header">
        <span class="token-server-badge">${t.label}</span>
        <span class="token-status ${t.has ? 'status-ok' : 'status-empty'}">${t.has ? '✅ 已配置' : '❌ 未配置'}</span>
      </div>
      <div class="token-card-body">
        <div class="token-masked"><code>${t.masked}</code></div>
        ${t.length ? `<small>Token 长度: ${t.length}</small>` : ''}
        <div class="token-test-result" id="token-result-${t.server}"></div>
      </div>
      <div class="token-card-actions">
        <button class="btn-token-test" onclick="testToken('${t.server}')">🔍 测试健康度</button>
        <button class="btn-token-edit" onclick="showTokenEdit('${t.server}')">✏️ 更新 Token</button>
      </div>
      <div class="token-edit-form" id="token-edit-${t.server}" style="display:none;">
        <input type="password" id="token-input-${t.server}" placeholder="粘贴新的 Token" class="token-input">
        <div class="token-edit-btns">
          <button class="btn-token-save" onclick="saveToken('${t.server}')">💾 保存</button>
          <button class="btn-token-cancel" onclick="hideTokenEdit('${t.server}')">取消</button>
        </div>
      </div>
    </div>
  `).join('');
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
    html += `<div class="channel-group">
      <h3 class="channel-group-title">${botLabels[bot] || bot} (${list.length})</h3>
      <div class="channel-group-list">`;
    for (const ch of list) {
      html += `<div class="channel-item">
        <div class="channel-item-info">
          <span class="channel-name">${escapeHtml(ch.name)}</span>
          <code class="channel-id">${ch.channel_id}</code>
        </div>
        <button class="btn-channel-del" onclick="deleteChannel('${encodeURIComponent(ch.name)}')" title="删除">🗑️</button>
      </div>`;
    }
    html += '</div></div>';
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

// 页面加载时初始化
window.addEventListener('DOMContentLoaded', () => {
  const user = getCurrentUser();
  if (!user) {
    window.location.href = '/login';
    return;
  }
  console.log('🔐 权限管理页面 - 当前用户:', user.name, '角色:', user.role);
  loadUsers();
});
