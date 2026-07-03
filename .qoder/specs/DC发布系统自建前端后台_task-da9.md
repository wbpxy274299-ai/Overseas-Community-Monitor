# DC 发布系统 — 自建前端+后台+数据库

## 背景
用户已有阿里云服务器，目前依赖钉钉 aitable + dws CLI 读写任务数据。目标是搭建自己的 web 系统，彻底摆脱钉钉依赖，让提交、查看、取消/撤回全部在自己服务器上完成。

## 架构

```
浏览器(单页HTML) → Flask API → SQLite 数据库 ← 扫描器常驻进程(读写同一DB)
```

所有组件运行在同一台阿里云服务器上，SQLite 使用 WAL 模式确保并发安全。

## 项目文件结构

```
/app/dc-publish/
├── app.py                    # Flask 主入口(API + 静态文件托管)
├── db.py                     # SQLite 数据库操作封装
├── scanner.py                # 改造后的扫描器(从 dws 改为 SQLite)
├── config.py                 # 集中配置
├── requirements.txt          # flask, requests
├── dc-publish-channels.json  # 频道映射(沿用现有)
├── .env                      # Discord Bot Token(沿用现有)
├── db/
│   └── tasks.db              # SQLite 数据库文件
├── static/
│   ├── index.html            # 单页前端(三个Tab)
│   ├── style.css             # 简洁实用样式
│   └── app.js                # 前端逻辑(fetch调用API)
└── discord_recall.py         # 独立撤回脚本(保留,手动调试用)
```

## 数据库 Schema

```sql
CREATE TABLE tasks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    request_type  TEXT NOT NULL DEFAULT 'send',   -- send/cancel/recall
    status        TEXT NOT NULL DEFAULT 'received', -- received/scheduled/sending/sent/failed/timeout/recalled/cancelled/sent_no_cancel
    channel_name  TEXT NOT NULL,
    content       TEXT,
    image_urls    TEXT,                           -- 逗号分隔
    send_time     TEXT,                           -- ISO8601 定时时间
    actual_time   TEXT,                           -- 实际发送时间
    message_id    TEXT,                           -- Discord消息ID
    fail_reason   TEXT,
    sender        TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_send_time ON tasks(send_time);
CREATE INDEX idx_tasks_created ON tasks(created_at DESC);
```

必须启用 WAL 模式: `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`

## Flask API 端点

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/` | 返回前端页面 |
| POST | `/api/tasks` | 新建任务(发送/取消/撤回) |
| GET | `/api/tasks` | 查询列表(支持status/channel筛选+分页) |
| GET | `/api/tasks/<id>` | 查单条详情 |
| PUT | `/api/tasks/<id>` | 取消或请求撤回 |
| POST | `/api/tasks/<id>/retry` | 重试失败任务 |
| GET | `/api/channels` | 获取频道列表(从JSON读取) |

## 前端设计(单页三个Tab)

**Tab1 提交发送**: 频道下拉(按服务器分组) + 消息textarea + 图片URL输入 + 定时时间选择 + 提交人(可选)
**Tab2 任务列表**: 状态筛选 + 频道筛选 + 表格(ID/频道/内容摘要/状态彩色标签/操作按钮)
**Tab3 取消/撤回**: 输入任务ID → 显示状态 → 一键取消或撤回

纯原生JS，fetch调用API，无需任何构建工具或CSS框架。

## 扫描器改造

核心改造: 删除所有 dws/aitable 依赖，改用 db.py 直接操作SQLite。

| 原代码 | 改造后 |
|--------|--------|
| F字典(aitable字段ID映射) | 删除，用SQL列名 |
| get_cell_val() | 删除，SQLite返回标准类型 |
| dws()/run_cmd() | 删除，不再需要subprocess |
| query_records() | db.list_tasks() |
| update_record() | db.update_task() |
| REQUEST_TYPES emoji映射 | 数据库存纯英文(send/cancel/recall) |
| STATUS emoji映射 | 数据库存纯英文，emoji仅前端展示 |

保留不变: discord_send()、discord_recall()、daemon_loop()、代理配置、频道JSON

## 实施步骤

1. 创建 config.py + db.py，初始化SQLite建表
2. 编写 app.py (Flask API全部端点)
3. 编写前端 index.html + style.css + app.js
4. 改造 scanner.py，替换dws为SQLite
5. 本地联调: 前端提交 → DB写入 → scanner扫描执行
6. 部署阿里云: pip install、systemd配置、启动验证
7. (可选) nginx反代 + Let's Encrypt HTTPS

## 验证方式

1. 浏览器访问 `http://服务器IP:5000` → 能看到页面
2. 提交一条发送请求 → 数据库写入received状态 → 任务列表Tab能看到
3. scanner扫描 → 状态变为sent → 任务列表Tab刷新看到已发送
4. 请求撤回 → scanner处理 → 状态变为recalled
5. 请求取消 → 状态变为cancelled
6. 提交未来时间的任务 → scanner跳过(时间未到) → 等时间到了再扫到就发送

## 注意事项

- SQLite WAL模式确保Flask和Scanner并发读写安全
- .env文件权限设600，Token不通过前端API暴露
- 频道列表API仅返回名称和server，不暴露channel_id和token
- 图片暂为URL输入方式，未来可扩展上传接口
- 建议配置cron每日备份SQLite文件