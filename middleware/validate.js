/**
 * 输入验证中间件
 * 根据 schema 规则自动校验 req.body，不通过则返回 400
 */
const db = require('../db');

/**
 * 角色权限校验中间件
 * @param {'admin'} role — 需要的最低角色
 * @returns {Function} Express 中间件
 */
function requireRole(role) {
  return (req, res, next) => {
    const operator = decodeURIComponent(req.headers['x-operator'] || '');
    if (!operator) {
      return res.status(401).json({ error: '未登录' });
    }
    if (role === 'admin' && !db.isAdmin(operator)) {
      return res.status(403).json({ error: '权限不足，需要管理员权限' });
    }
    next();
  };
}

function validateInput(schema) {
  return (req, res, next) => {
    const errors = [];
    const data = req.body || {};

    for (const [field, rules] of Object.entries(schema)) {
      const value = data[field];

      // 必填字段检查
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field} 是必填项`);
        continue;
      }

      // 空值且非必填 → 跳过
      if (value === undefined || value === null || value === '') continue;

      // 类型检查
      if (rules.type) {
        if (rules.type === 'string' && typeof value !== 'string') {
          errors.push(`${field} 必须是字符串`);
          continue;
        }
        if (rules.type === 'number' && typeof value !== 'number') {
          errors.push(`${field} 必须是数字`);
          continue;
        }
        if (rules.type === 'array' && !Array.isArray(value)) {
          errors.push(`${field} 必须是数组`);
          continue;
        }
      }

      // 字符串长度
      if (rules.maxLength && typeof value === 'string' && value.length > rules.maxLength) {
        errors.push(`${field} 不能超过 ${rules.maxLength} 字符`);
      }
      if (rules.minLength && typeof value === 'string' && value.length < rules.minLength) {
        errors.push(`${field} 不能少于 ${rules.minLength} 字符`);
      }

      // 数字范围
      if (rules.min !== undefined && typeof value === 'number' && value < rules.min) {
        errors.push(`${field} 不能小于 ${rules.min}`);
      }
      if (rules.max !== undefined && typeof value === 'number' && value > rules.max) {
        errors.push(`${field} 不能大于 ${rules.max}`);
      }

      // 自定义验证函数
      if (rules.validate && typeof rules.validate === 'function') {
        const customError = rules.validate(value);
        if (customError) errors.push(customError);
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: '输入验证失败', details: errors });
    }
    next();
  };
}

module.exports = { validateInput, requireRole };
