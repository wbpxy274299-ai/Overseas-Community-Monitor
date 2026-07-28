/**
 * 权限管理 — 页面逻辑
 * 使用 JWT Cookie 认证，服务端校验角色
 */
const API_BASE = '/api/admin';

// 获取当前用户（从 common.js 的 localStorage 读取，由 home.js 登录后写入）
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
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">暂无用户</td></tr>';
    return;
  }
  let html = '';
  for (const user of users) {
    const isAdmin = user.role === 'admin';
    const roleBadge = isAdmin
      ? '<span class="badge badge-admin">👑 管理员</span>'
      : '<span class="badge badge-user">👤 普通用户</span>';
    const actionBtn = isAdmin
      ? `<button class="btn btn-danger" onclick="changeRole('${user.username}', 'user')" ${user.username === '阿饱' ? 'disabled' : ''}>降级为普通用户</button>`
      : `<button class="btn btn-primary" onclick="changeRole('${user.username}', 'admin')">提升为管理员</button>`;
    html += `
      <tr>
        <td><strong>${escapeHtml(user.username)}</strong></td>
        <td>${roleBadge}</td>
        <td>${formatDate(user.created_at)}</td>
        <td>${actionBtn}</td>
      </tr>`;
  }
  tbody.innerHTML = html;
}

// 修改用户角色
async function changeRole(username, newRole) {
  if (!confirm(`确定要将 ${username} ${newRole === 'admin' ? '提升为管理员' : '降级为普通用户'}吗？`)) return;
  try {
    const response = await fetch(`${API_BASE}/users/${username}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
      credentials: 'same-origin'
    });
    const data = await response.json();
    if (data.ok) {
      Toast.success(`✅ 已将 ${username} ${newRole === 'admin' ? '提升为管理员' : '降级为普通用户'}`);
      loadUsers();
    } else {
      Toast.error('❌ 操作失败: ' + data.error);
    }
  } catch (error) {
    console.error('修改角色失败:', error);
    Toast.error('❌ 网络错误');
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
