/**
 * 历史数据 — 页面逻辑
 */
let currentPage = 1;
const pageSize = 50;
let totalRecords = 0;
let currentFilters = {};

// 初始化日期（默认最近7天）
function initDates() {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 7);
  document.getElementById('endDate').value = formatDateInput(endDate);
  document.getElementById('startDate').value = formatDateInput(startDate);
  document.getElementById('platformFilter').value = 'twitter';
}

function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 加载数据
async function loadData(page = 1) {
  currentPage = page;
  const platform = document.getElementById('platformFilter').value;
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  currentFilters = { platform, startDate, endDate };

  document.getElementById('loadingState').style.display = 'block';
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('dataTable').style.display = 'none';
  document.getElementById('pagination').style.display = 'none';

  try {
    const params = new URLSearchParams({ page: currentPage, pageSize, ...currentFilters });
    const response = await fetch(`/api/sentiment/history?${params}`);
    const result = await response.json();
    if (!result.success) throw new Error(result.error || '加载失败');
    totalRecords = result.total;
    renderTable(result.data);
    renderPagination(result.total, pageSize, currentPage);
  } catch (error) {
    console.error('加载数据失败:', error);
    alert('加载数据失败: ' + error.message);
  } finally {
    document.getElementById('loadingState').style.display = 'none';
  }
}

// 渲染表格
function renderTable(data) {
  const tbody = document.getElementById('tableBody');
  if (!data || data.length === 0) {
    document.getElementById('emptyState').style.display = 'block';
    return;
  }
  document.getElementById('dataTable').style.display = 'table';
  tbody.innerHTML = data.map(item => {
    const platformClass = item.platform === 'twitter' ? 'platform-twitter' : 'platform-discord';
    const platformText = item.platform === 'twitter' ? 'Twitter' : 'Discord';
    const mediaBadge = item.has_media ? '<span class="media-badge">📷 有媒体</span>' : '';
    const urlLink = item.url ? `<a href="${item.url}" target="_blank" class="url-link">查看原帖 →</a>` : '-';
    const timeDisplay = formatTimestamp(item.created_at);
    return `
      <tr>
        <td><span class="platform-badge ${platformClass}">${platformText}</span></td>
        <td>${escapeHtml(item.author || '匿名')}</td>
        <td>${timeDisplay}</td>
        <td class="content-cell">${escapeHtml(item.content || '')}${mediaBadge}</td>
        <td>${urlLink}</td>
      </tr>`;
  }).join('');
}

// 渲染分页
function renderPagination(total, pageSize, current) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) {
    document.getElementById('pagination').style.display = 'none';
    return;
  }
  document.getElementById('pagination').style.display = 'flex';
  document.getElementById('pageInfo').textContent = `第 ${current} 页 / 共 ${totalPages} 页（共 ${total} 条）`;
  document.getElementById('prevBtn').disabled = current === 1;
  document.getElementById('nextBtn').disabled = current === totalPages;
}

// 切换页码
function changePage(delta) {
  loadData(currentPage + delta);
}

// 页面加载时初始化
window.onload = () => { initDates(); loadData(); };
