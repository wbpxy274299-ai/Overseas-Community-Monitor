/**
 * 权限管理 — 页面逻辑
 * 使用 JWT Cookie 认证，服务端校验角色
 * 支持 3 级角色: viewer / operator / admin
 */
const API_BASE = '/api/admin';

const ROLE_LABELS = {
  viewer:   { icon: '👁️', name: '查看者', desc: '只能查看舆情、术语、反馈' },
  operator: { icon: '⚙️', name: '运营员', desc: 'DC发布 + 舆情/周报/历史(只读)' },
  admin:    { icon: '👑', name: '管理员', desc: '全部权限' },
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
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">暂无用户</td></tr>';
    return;
  }

  const currentUser = getCurrentUser();

  let html = '';
  for (const user of users) {
    const role = user.role || 'operator';
    const roleInfo = ROLE_LABELS[role] || ROLE_LABELS.operator;
    const roleBadge = `<span class="badge badge-${role === 'admin' ? 'admin' : role === 'viewer' ? 'info' : 'success'}">${roleInfo.icon} ${roleInfo.name}</span>`;

    // 构建角色选择器（排除当前角色）
    const isSelf = currentUser && user.username === currentUser.name;
    const roleSelector = buildRoleSelector(user.username, role, isSelf);

    html += `
      <tr>
        <td>
          <strong>${escapeHtml(user.username)}</strong>
          ${user.email ? `<br><small style="color:#888;">${escapeHtml(user.email)}</small>` : ''}
          ${isSelf ? '<span class="badge badge-info" style="margin-left:6px;">你</span>' : ''}
        </td>
        <td>${roleBadge}</td>
        <td><small style="color:#666;">${roleInfo.desc}</small></td>
        <td>${formatDate(user.created_at)}</td>
        <td>${roleSelector}</td>
      </tr>`;
  }
  tbody.innerHTML = html;
}

// 构建角色选择下拉框
function buildRoleSelector(username, currentRole, isSelf) {
  const roles = ['viewer', 'operator', 'admin'];
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
    const response = await fetch(`${API_BASE}/users/${username}/role`, {
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
