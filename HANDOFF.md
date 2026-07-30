# 会话交接文档
> 最后更新：2026-07-29 22:40  
> 服务器状态：本地运行中（端口 5000，node server.js）

---

## 一、项目概况

**项目名**：Overseas-Community-Monitor（M2G 用户运营后台）  
**技术栈**：Node.js + Express + SQLite（better-sqlite3）+ JWT 认证 + DeepSeek API  
**端口**：5000  
**数据库**：`db/tasks.db`（SQLite）  
**术语库**：`terminology.js` 加载约 10 万条游戏术语  
**超级管理员邮箱**：`wbpxy274299@gmail.com`（定义在 `db.js` 的 `SUPER_ADMIN_EMAILS`）

### 核心功能模块
| 页面路径 | 功能 | 最低角色 |
|---------|------|---------|
| `/` | DC 发布主页 | operator |
| `/sentiment` | 舆情监控日报 | viewer |
| `/sentiment-history` | 历史数据 | operator |
| `/reports` | 周报管理 | operator |
| `/insights` | 玩家洞察 | super_admin |
| `/terminology` | 术语校对 | viewer |
| `/post-assistant` | **贴文助手** | operator + postAssistant 权限 |
| `/admin` | 权限管理 | admin |

### 5 级角色体系（低→高）
`pending` → `viewer` → `operator` → `admin` → `super_admin`

---

## 二、本轮会话完成的所有工作

### 1. 贴文助手页面 — AI Studio 集成 + UI 重构
- **左栏**：iframe 直嵌阿里 AI Studio 聊天窗（`appCode=vAKIOhyPlmw`），需阿里内网
- **右栏**：贴文编辑器 + DeepSeek 翻译7语言 + 校对 + 清空
- **翻译缓存**：localStorage 存翻译结果，1自然天过期，切换页面不丢失
- **翻译质量优化**：重写了 DeepSeek system prompt（术语注入、结构保持、地道翻译）
- **结构保持**：翻译结果保留原文换行/段落（`white-space: pre-wrap`）

### 2. 翻译限次系统（每人每天 15 次）
- 翻译和校对都计数
- 超级管理员不限
- 内存计数，每天自动清零（key: `username|date`）
- 页面显示剩余次数（绿→黄→红三色）
- 超限时显示"阿饱的个人自费 AI API，为避免阿饱破产"提示

### 3. 贴文助手权限开关
- 新增 `postAssistant` 权限字段（存入 `user_permissions` JSON 列）
- 默认开启（`perms.postAssistant !== false`）
- 管理员可在 `/admin` 页面为每个 operator 开关
- 无权限用户访问 `/post-assistant` 会被重定向到 `/sentiment`

---

## 三、贴文助手 — 完整技术架构

### 文件清单

| 文件 | 类型 | 行数 | 职责 |
|------|------|------|------|
| `views/post-assistant.html` | HTML | 78 | 页面骨架：左右分栏布局 |
| `public/js/post-assistant.js` | JS 前端 | 304 | 翻译/校对逻辑、缓存、剩余次数显示 |
| `public/css/pages/post-assistant.css` | CSS | 212 | 两栏布局、卡片、暗色适配 |
| `routes/terminology.js` | 后端路由 | 165 | AI 代理 + 限次检查 + 剩余查询 API |
| `routes/pages.js` | 页面路由 | 89 | `/post-assistant` 权限检查 |
| `routes/admin.js` | 后端路由 | 494 | 权限管理 API（接受 postAssistant 字段） |
| `public/js/admin.js` | JS 前端 | 463 | 权限管理 UI（贴文助手开关） |
| `db.js` | 数据库 | 521 | 权限查询 + 翻译计数函数 |

### 工作链路
```
用户输入中文贴文
    ↓
paTranslate() 检查 localStorage 缓存 → 命中则秒出
    ↓（未命中）
查术语库 GET /api/terminology/search?text=xxx&lang=auto&limit=50
    ↓
组装 system prompt（含术语对照表 + 翻译要求）
    ↓
POST /api/terminology/ai { source: 'post-assistant' }
    ↓
后端检查：非 super_admin 且 remaining <= 0 → 返回 429
    ↓
调用 DeepSeek API → 返回 JSON 格式的 7 语言翻译
    ↓
后端扣减次数 → 返回 { ok: true, data: { content }, remaining: N }
    ↓
前端解析 JSON → 渲染 7 张语言卡片 → 存入 localStorage 缓存
    ↓
paProofread() 遍历 7 语言查术语 → DeepSeek 校对 → 显示校对报告
```

### API 端点

| 端点 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/api/terminology/ai` | POST | requireAuth | AI 代理（DeepSeek），source=post-assistant 时限次 |
| `/api/terminology/translation-remaining` | GET | requireAuth | 查询剩余翻译次数 |
| `/api/terminology/search` | GET | 无 | 术语搜索/文本提取 |
| `/api/admin/users/:username/permissions` | PUT | admin+ | 设置权限（含 postAssistant） |

### 翻译限次逻辑（routes/terminology.js L44-100）
```
请求带 source: 'post-assistant' 时：
  1. 检查 req.user.role === 'super_admin' → 不限
  2. 非超管 → db.getTranslationRemaining(username)
  3. remaining <= 0 → 返回 429 + 阿饱提示
  4. DeepSeek 调用成功后 → db.incrementTranslationUsage(username)
  5. 响应体带 remaining 字段
```

### 翻译限次计数（db.js L343-364）
```js
const DAILY_TRANSLATION_LIMIT = 15;
const _translationUsage = new Map(); // key: "username|date", value: count
// getTranslationUsage / incrementTranslationUsage / getTranslationRemaining
```
内存存储，key 含日期字符串（`toDateString()`），自然日自动过期。

### 权限字段（db.js L305-331）
```
user_permissions JSON 格式：
{
  "upload": true/false,        // 上传舆情数据
  "regions": ["JP","TC",...],  // 可操作地区
  "postAssistant": true/false  // 贴文助手访问权（默认 true）
}
admin/super_admin 忽略此字段，默认全权限
```

---

## 四、用户偏好（重要！必须遵守）

### 最高优先级：大白话 + 比喻解释
- **禁止用技术术语**（API、SDK、Promise、middleware 等）
- 所有解释必须用日常生活比喻（餐厅、咖啡机、便签本、门禁卡等）
- 用户不懂编程

### 改→验→清 三步工作法
1. **改**：梳理所有涉及文件，一次性改完关联代码
2. **验**：端到端验证完整链路
3. **清**：清理临时脚本

### 避免死循环规范
- 同一操作最多尝试 2 次，第 2 次失败必须换方案
- 禁止改一点就重启验证
- 先读全链路代码再动手

### 排查问题
- 必须先看前端实际展示（views/xxx.html + public/js/xxx.js）
- 先测试后假设

---

## 五、已知限制和问题

### AI Studio
- **必须阿里内网**才能访问，外网 iframe 加载不出来
- SDK 的 `messageCallback` 在 iframe 直嵌时不触发（已放弃，改用 DeepSeek）

### Gemini API
- Key 已配置（`.env` 中的 `GEMINI_API_KEY`），但**免费额度为 0**
- 代码已写好（`/api/terminology/gemini` 路由），Key 恢复后可用

### DeepSeek API
- **不支持图片输入**（仅文本）
- 翻译每次约消耗 3000-5000 token（约 ¥0.005-0.01）
- 所有 AI 调用统一用 DeepSeek（`DEEPSEEK_API_KEY`）

### 翻译缓存
- localStorage 存储，key 基于文本长度+前100字符的简易 hash
- 同一文本当天重复翻译会命中缓存（不扣次数）
- 清空按钮只清 UI，不清 localStorage 缓存

### 翻译次数
- 存内存，服务器重启会清零（可接受）
- 缓存命中时不扣次数

---

## 六、Git 状态

### 未提交修改的文件
```
 M db.js                       ← 新增 postAssistant 权限 + 翻译计数
 M public/js/admin.js          ← 新增贴文助手权限开关
 M public/js/common.js         ← 导航栏（前轮会话改的）
 M routes/admin.js             ← 权限 API 接受 postAssistant
 M routes/pages.js             ← 贴文助手页检查权限
 M routes/terminology.js       ← AI 限次 + 剩余查询 API
 M views/terminology.html      ← 术语页（前轮会话改的）
 M public/css/components.css   ← 全局样式（前轮会话改的）
 M public/css/pages/terminology.css
 M public/js/terminology.js
 M terminology.js
```

### 新增未跟踪的文件
```
 ?? public/css/pages/post-assistant.css  ← 贴文助手样式
 ?? public/js/post-assistant.js          ← 贴文助手前端逻辑
 ?? views/post-assistant.html            ← 贴文助手页面
```

---

## 七、环境配置（.env 中需要的 Key）

| 变量 | 用途 | 获取地址 |
|------|------|---------|
| `DEEPSEEK_API_KEY` | 所有 AI 调用 | https://platform.deepseek.com/api_keys |
| `GEMINI_API_KEY` | Gemini（目前免费额度为0） | Google AI Studio |
| `GOOGLE_CLIENT_ID` | OAuth 登录 | Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | OAuth 登录 | Google Cloud Console |
| `GOOGLE_CALLBACK_URL` | OAuth 回调 | 生产环境必须 HTTPS |
| `DISCORD_*_BOT_TOKEN` | 4个DC机器人 | Discord Developer Portal |
| `JWT_SECRET` | JWT 签名 | 自定义 |

---

## 八、启动命令

```powershell
# 停止 + 重启
Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force; node server.js

# 仅语法检查
node -c 文件名.js
```

---

## 九、可能的后续任务（用户未明确，仅参考）

1. **翻译质量反馈** — 用户说"翻译质量很差"，已优化 prompt，但可能需要继续调整
2. **部署到线上** — 当前所有改动未 commit/push
3. **翻译用量统计面板** — 目前只是内存计数，可考虑持久化
4. **AI Studio 替代方案** — 如果内网限制太麻烦，可能需要其他方案
5. **Gemini 恢复** — 如果 API 额度恢复，可以启用图片识别功能
