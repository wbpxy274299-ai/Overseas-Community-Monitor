/**
 * 权限管理 — 页面逻辑
 */
const API_BASE = '/api/admin';

// 获取当前用户
function getCurrentUser() {
  const name = localStorage.getItem('dc_operator');
  const role = localStorage.getItem('dc_user_role');
  if (!name) return null;
  return { name, role: role || 'user' };
}

// 加载用户列表
async function loadUsers() {
  const user = getCurrentUser();
  if (!user) {
    Toast.error('❌ 请先登录');
    setTimeout(() => { window.location.href = '/'; }, 2000);
    return;
  }
  if (user.role !== 'admin') {
    Toast.error('❌ 权限不足，需要管理员权限');
    setTimeout(() => { window.location.href = '/'; }, 2000);
    return;
  }
  try {
    const response = await fetch(`${API_BASE}/users`, {
      headers: { 'x-operator': encodeURIComponent(user.name) }
    });
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
  const user = getCurrentUser();
  try {
    const response = await fetch(`${API_BASE}/users/${username}/role`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-operator': encodeURIComponent(user.name)
      },
      body: JSON.stringify({ role: newRole })
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
    Toast.error('❌ 请先登录');
    setTimeout(() => { window.location.href = '/'; }, 2000);
    return;
  }
  console.log('🔐 权限管理页面 - 当前用户:', user.name, '角色:', user.role);
  loadUsers();
});
