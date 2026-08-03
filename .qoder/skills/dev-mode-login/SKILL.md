---
name: dev-mode-login
description: 为 Node.js/Express 项目生成开发者模式登录页面，绕过 Google OAuth 等第三方登录，支持多角色一键切换。适用于本地开发和调试时快速以不同权限身份登录系统。当用户提到"开发者模式"、"dev login"、"免登录"、"开发环境登录"时使用此 skill。
---

# 开发者模式登录

为 Express 项目快速生成一套本地开发专用的免密登录系统，支持多角色一键切换。

## 核心功能

- 预设 5 级角色：super_admin / admin / operator / viewer / pending
- 一键登录（点击即签发 JWT Cookie）
- 自动在 DB 创建/更新用户记录
- 仅开发环境加载，不推送到生产

## 使用步骤

### 1. 生成文件

在项目的 `routes/` 目录下创建 `dev-auth.js`，内容参考 [templates/dev-auth.js](templates/dev-auth.js)。

需根据项目调整的部分：
- `DEV_USERS` 中的 email / googleId
- 登录后跳转路径
- auth 中间件 import 路径（`issueSession`, `clearSession`）
- DB 模块 import 路径

### 2. 条件加载

```js
if (process.env.NODE_ENV !== 'production') {
  app.use(require('./routes/dev-auth'));
}
```

### 3. 排除版本控制

`.gitignore` 加入：`routes/dev-auth.js`

### 4. 访问

`http://localhost:端口/login` → 点击角色按钮即登录

## 自定义角色

编辑 `DEV_USERS` 对象，格式：

```js
const DEV_USERS = {
  role_name: {
    googleId: 'dev-role-xxx',
    username: '显示名称',
    email: 'dev@test.com',
    role: 'role_name',
    picture: '',
  },
};
```

## 安全规则

- `routes/dev-auth.js` 必须加入 `.gitignore`
- 生产环境 `NODE_ENV=production` 时不加载
- 模板中已内置黄色警告横幅提醒"本地开发模式"
