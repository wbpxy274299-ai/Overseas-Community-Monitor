# M2G 运营后台 — 全模块架构盘点

## 一、基础设施层（写死，不可动）

| 项目 | 文件 | 说明 |
|---|---|---|
| 时区 | `server.js` L7 | `process.env.TZ = 'Asia/Shanghai'`，全局 UTC+8 |
| 日期格式 | `config.js` L99-114 | `fmtCST8()` / `fmtCST8Date()`，唯一标准 `YYYY-MM-DD HH:MM:SS` |
| 数据库引擎 | `db.js` | `sql.js`（纯 JS SQLite），**不是** better-sqlite3 |
| 数据库文件 | `db/tasks.db` | 所有表都在这一个文件里 |
| 端口 | `server.js` L40 | `PORT = 5000` |
| 认证方式 | `middleware/auth.js` | Google OAuth + JWT + HttpOnly Cookie，7天有效期 |
| 角色体系 | `db.js` L267 | `pending → viewer → operator → admin → super_admin`（5级） |
| 超级管理员邮箱 | `db.js` L270 | `wbpxy274299@gmail.com`（永久保护） |
| 全局限流 | `middleware/rateLimit.js` | `/api/` 前缀统一限流 |

## 二、DC 发布模块

| 项目 | 内容 |
|---|---|
| **前端页面** | `views/index.html` + `public/js/home.js` |
| **后端路由** | `routes/dc.js` |
| **业务逻辑** | `scanner.js`（Discord API 调用 + 守护进程） |
| **配置文件** | `config.js`（频道映射、Bot Token、发送人） |
| **频道配置** | `dc-publish-channels.json`（运行时可改） |
| **数据库表** | `tasks` — 发布任务（发送/定时/撤回/取消） |
| **上传目录** | `uploads/` — 图片文件 |

**API 端点：**
- `GET /api/channels` — 频道列表
- `GET /api/senders` — 发送人列表
- `POST /api/tasks` — 新建任务
- `POST /api/upload` — 图片上传
- `GET /api/token-status` — Bot Token 诊断（admin）

**数据流：**
```
用户填表单 → POST /api/tasks → 写入 tasks 表
→ scanner.js daemonLoop() 每分钟扫描
→ 到时间 → Discord API 发送 → 更新 tasks.status
```

**写死规则：**
- 4 个服务器：TC（繁中）、JP（日服）、SEA（东南亚）、KR（韩服）
- 发送人映射：`TC→小梅, JP→メイメイ, SEA→Mei, KR→티메이`
- 任务状态机：`received → scheduled → sending → sent/failed/recalled/cancelled`

**可改：**
- 频道列表（通过 `dc-publish-channels.json` 或管理后台）
- Bot Token（通过 `.env` 或管理后台）

## 三、舆情监控模块

| 项目 | 内容 |
|---|---|
| **前端页面** | `views/sentiment.html` + `public/js/sentiment.js` |
| **后端路由** | `routes/sentiment.js`（1343行，最大文件） |
| **业务逻辑** | `sentiment.js`（3381行，采集+分析+统计） |
| **AI 分析** | `ai_analyzer.js`（DeepSeek API） |
| **翻译** | `translator.js`（DeepSeek + 术语注入） |
| **数据库表** | `sentiment_records` — 舆情原始记录 |
| | `topic_history` — 话题历史（AI 分析结果） |
| | `daily_snapshots` — 每日快照 |
| | `weekly_reports` — 周报 |

**API 端点：**
- `GET /api/sentiment/statistics` — 统计数据（30分钟缓存）
- `GET /api/sentiment/daily` — 今日数据
- `GET /api/sentiment/realtime` — 实时数据
- `GET /api/sentiment/history` — 历史数据
- `GET /api/sentiment/feedback` — 玩家反馈列表
- `GET /api/sentiment/lounge-posts` — 韩国社区帖子列表
- `GET /api/sentiment/lounge-stats` — 韩国社区统计
- `GET /api/sentiment/lounge-comments/:postId` — 帖子评论
- `GET /api/sentiment/lounge-daily` — 韩国社区每日数据
- `POST /api/sentiment/collect` — 手动采集（super_admin）
- `POST /api/sentiment/force-analyze` — 强制 AI 分析（super_admin）
- `POST /api/sentiment/refresh-analysis` — 刷新分析（operator+）

**数据流：**
```
定时任务(scheduler.js) 每天 8:30
→ sentiment.collectFromTwitter() → Yahoo 搜索 API
→ sentiment.collectFromDiscord() → Discord API
→ batchSaveRecords() → 写入 sentiment_records
→ runDailyHotTopicsAnalysis() → AI 分析 → 写入 topic_history
→ saveDailySnapshot() → 写入 daily_snapshots
```

**写死规则：**
- 分析周期：昨日 8:30 ~ 今日 8:30
- Twitter 平台 region = `jp`（自动修正）
- Discord 平台 region = `tc`
- 噪音过滤：`is_noise = 0` 才计入统计
- 质量评分：`content_quality >= 2` 才进入 AI 分析

**可改：**
- AI 模型（目前 DeepSeek，可换）
- 分析时间（目前 8:30，可调）

## 四、韩国社区监控模块

| 项目 | 内容 |
|---|---|
| **前端页面** | `views/sentiment-history.html` + `public/js/history.js` |
| **后端路由** | `routes/lounge.js`（905行） |
| **爬虫** | `lounge_crawler.js`（678行） |
| **数据库表** | `lounge_posts` — 帖子 |
| | `lounge_comments` — 评论 |

**API 端点：**
- `GET /api/lounge/posts` — 帖子列表（分页+筛选）
- `GET /api/lounge/posts/:postId` — 帖子详情
- `GET /api/lounge/reports` — 洞察报告
- `GET /api/lounge/status` — 爬虫状态
- `GET /api/lounge/progress` — 爬虫进度
- `POST /api/lounge/crawl` — 手动触发爬虫
- `POST /api/lounge/clean-content` — 正文清洗
- `GET /api/lounge/games` — 游戏列表
- `POST /api/lounge/clear-data` — 清空数据
- `POST /api/lounge/delete-before` — 删除指定日期前数据

**数据流：**
```
定时任务(scheduler.js) 每天 0:00 + 9:00 + 21:00
→ lounge_crawler.crawlLounge()
→ Naver Lounge API 获取帖子列表
→ 排重（已有帖子跳过）
→ 逐个抓取详情 + 评论
→ saveCrawlResult() → 写入 lounge_posts + lounge_comments
→ translateAndAnalyze() → 翻译 + AI 分析
```

**写死规则（不可动）：**
- 评论抓取三条件：2天内新帖 / 评论数增加 / 首次出现
- 排重策略：`post_id + game_code` 唯一
- 帖子时间格式：`YYYY-MM-DD HH:MM:SS`（UTC+8）
- 评论时间格式：同上

**可改：**
- 游戏列表（`LOUNGE_CONFIG.games`）
- 每次抓取数量（`LOUNGE_CONFIG.maxPosts`）
- 评论抓取数量（`LOUNGE_CONFIG.maxComments`）

## 五、玩家洞察模块（仅 super_admin）

| 项目 | 内容 |
|---|---|
| **前端页面** | `views/insights.html` + `public/js/insights.js` |
| **后端路由** | `routes/admin.js`（部分） |
| **数据库表** | `insights_reports` — 洞察报告存档 |

**API 端点：**
- `POST /api/admin/insights/analyze` — 生成洞察报告
- `GET /api/admin/insights/list` — 报告列表
- `GET /api/admin/insights/:id` — 报告详情

## 六、周报模块

| 项目 | 内容 |
|---|---|
| **前端页面** | `views/reports.html` + `public/js/reports.js` |
| **业务逻辑** | `weekly_report.js`（662行） |
| **数据库表** | `weekly_reports`（与舆情共用） |

**写死规则：**
- 周报范围：上周一 0:00 ~ 上周日 23:59
- 只统计 Twitter + Discord 繁中服 + 韩服 Lounge

## 七、权限管理模块

| 项目 | 内容 |
|---|---|
| **前端页面** | `views/admin.html` + `public/js/admin.js` |
| **后端路由** | `routes/admin.js`（804行） |
| **数据库表** | `users` — 用户表 |

**权限矩阵（写死）：**
| 页面 | viewer | operator | admin | super_admin |
|---|---|---|---|---|
| DC 发布 |  | ✅ | ✅ | ✅ |
| 舆情监控 | ✅ | ✅ | ✅ | ✅ |
| 历史数据 | ❌ | ✅ | ✅ | ✅ |
| 周报 | ❌ | 只读 | ✅ | ✅ |
| 玩家洞察 | ❌ | ❌ |  | ✅ |
| 术语校对 | ✅ | ✅ | ✅ | ✅ |
| 权限管理 | ❌ |  | ✅ | ✅ |
| 贴文助手 |  | 需授权 | ✅ | ✅ |

## 八、术语校对模块

| 项目 | 内容 |
|---|---|
| **前端页面** | `views/terminology.html` + `public/js/terminology.js` |
| **后端路由** | `routes/terminology.js` |
| **业务逻辑** | `terminology.js`（10万条术语库） |
| **术语数据** | `terminology-tool/data/terms.json` |

**API 端点：**
- `GET /api/terminology/search` — 搜索术语 / 文本校对
- `POST /api/terminology/batch-check` — 批量校对
- `POST /api/terminology/ai` — AI 翻译（DeepSeek + 术语注入，每日15次限制）

## 九、反馈模块

| 项目 | 内容 |
|---|---|
| **前端页面** | 集成在各页面中 |
| **后端路由** | `routes/feedback.js` |
| **数据库表** | `feedbacks` — 反馈表 |

**API 端点：**
- `POST /api/feedback` — 提交反馈（任何登录用户）
- `GET /api/feedback` — 反馈列表（admin，过滤7月27日前）
- `GET /api/feedback/unread-count` — 未读数量（admin）
- `PUT /api/feedback/:id/status` — 更新状态（admin）
- `DELETE /api/feedback/:id` — 删除反馈（admin）

## 十、定时任务调度器

| 项目 | 内容 |
|---|---|
| **文件** | `scheduler.js`（815行） |
| **状态持久化** | `.scheduler_state.json` |

**定时任务清单（写死）：**
| 时间 | 任务 | 说明 |
|---|---|---|
| 0:00~5:59 | 零点全量采集 | Twitter + Discord + 韩国社区 |
| 8:30 | 每日热门话题分析 | AI 分析昨日数据 |
| 9:00~11:59 | 韩国社区早间补抓 | 填补凌晨空档 |
| 10:00+ | 每日快照保存（保险） | 如果8:30没存则补存 |
| 14:00~17:59 | 下午备份采集 | 上午数据不足时补货 |
| 21:00~21:59 | 韩国社区晚间补抓 | 每日第二次 |
| 每小时 | 数据新鲜度看门狗 | 超过24小时未更新则补抓 |
| 每1分钟 | 检查定时发送任务 | DC 发布定时任务 |

## 十一、数据库表总览

| 表名 | 用途 | 写入方 | 读取方 |
|---|---|---|---|
| `tasks` | DC 发布任务 | `routes/dc.js` | `routes/dc.js`, `scanner.js` |
| `users` | 用户账号 | `db.js`, `routes/admin.js` | `middleware/auth.js`, 所有模块 |
| `sentiment_records` | 舆情原始记录 | `sentiment.js` | `routes/sentiment.js`, `weekly_report.js` |
| `topic_history` | 话题历史（AI分析） | `sentiment.js` | `routes/sentiment.js`, `routes/admin.js` |
| `daily_snapshots` | 每日快照 | `sentiment.js` | `routes/sentiment.js` |
| `weekly_reports` | 周报 | `weekly_report.js` | `routes/sentiment.js` |
| `lounge_posts` | 韩国社区帖子 | `routes/lounge.js` | `routes/sentiment.js`, `routes/lounge.js` |
| `lounge_comments` | 韩国社区评论 | `routes/lounge.js` | `routes/sentiment.js` |
| `insights_reports` | 洞察报告 | `routes/admin.js` | `routes/admin.js` |
| `feedbacks` | 用户反馈 | `routes/feedback.js` | `routes/feedback.js` |
| `dc_collection_cursor` | Discord 采集游标 | `db.js` | `scanner.js` |

## 十二、行为准则（写死，不可动）

1. **时区**：全局 UTC+8，`process.env.TZ = 'Asia/Shanghai'`
2. **日期格式**：`YYYY-MM-DD HH:MM:SS`，只用 `fmtCST8()`，禁止 `toISOString()`
3. **数据库引擎**：`sql.js`，不是 `better-sqlite3`
4. **角色体系**：5级（pending/viewer/operator/admin/super_admin）
5. **超级管理员**：`wbpxy274299@gmail.com` 永久保护
6. **评论抓取规则**：三条件触发（2天内/评论数增加/首次出现）
7. **舆情分析周期**：昨日 8:30 ~ 今日 8:30
8. **Twitter region**：`jp`（自动修正）
9. **Discord region**：`tc`
10. **噪音过滤**：`is_noise = 0` 才计入统计
11. **质量门槛**：`content_quality >= 2` 才进 AI 分析
12. **翻译限制**：每人每天 15 次（super_admin 不限）
13. **反馈过滤**：只显示 2026-07-27 之后的数据
14. **采集锁**：`isCollecting` 防止并发，30分钟卡死自动解锁
15. **调度器状态**：`.scheduler_state.json` 持久化，重启后恢复

## 十三、可改项（需要变更时走正常流程）

1. **频道列表**：`dc-publish-channels.json` 或管理后台
2. **Bot Token**：`.env` 或管理后台
3. **游戏列表**：`LOUNGE_CONFIG.games`
4. **AI 模型**：目前 DeepSeek，可换其他
5. **分析时间**：目前 8:30，可调
6. **抓取数量**：`LOUNGE_CONFIG.maxPosts/maxComments`
7. **用户权限**：管理后台实时调整
8. **术语库**：`terminology-tool/data/terms.json`
