/* ========================================
   游戏术语校对工具 - 主入口 / 事件绑定
   ======================================== */

document.addEventListener('DOMContentLoaded', () => {
  // Tab 切换
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => {
        t.classList.remove('active');
        t.style.background = '#f0f0f0';
        t.style.color = '#333';
      });
      tab.classList.add('active');
      tab.style.background = '#fff';
      tab.style.color = '#764ba2';

      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    });
  });

  // 搜索回车触发
  document.getElementById('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch();
  });

  // 批量校对文件上传
  document.getElementById('batch-file').addEventListener('change', function (e) {
    if (e.target.files[0]) handleBatchCheck(e.target.files[0]);
  });

  // 初始化更新模块
  initUpdateModule();

  // 加载数据
  loadData();
});
