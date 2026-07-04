/**
 * 公共工具函数
 */

/**
 * XSS 防护：转义 HTML 特殊字符
 * @param {string} str - 原始字符串
 * @returns {string} 转义后的安全字符串
 */
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { escapeHtml };
