---
name: deploy-prod
description: 把代码部署到线上生产服务器（198.13.60.172）：git push 后 SSH 执行 git pull + pm2 restart dc-publish 并验证启动日志。只在用户明确说"部署/上线/推到线上"时使用，绝不自动部署。也用于远程查看线上日志、排查线上报错。
---

# 线上部署（deploy-prod）

## 铁律

- **只在用户明确下令时部署**（"部署吧"、"推到线上"、"上线"）。改完代码只推送 GitHub，**不许顺手部署**。
- 部署前确认本地改动已提交并推送。
- 服务器上只做：`git pull` + `pm2 restart`，**禁止在服务器上直接改代码、改数据库文件**。

## 服务器事实（已核实）

| 项目 | 值 |
|------|-----|
| 域名 | https://test-posting.xyz |
| IP / 用户 | 198.13.60.172 / root |
| 应用目录 | `/root/Overseas-Community-Monitor`（以 `pm2 describe dc-publish` 的 exec cwd 为准） |
| pm2 进程名 | `dc-publish` |
| 日志 | `/root/.pm2/logs/dc-publish-out.log` 和 `dc-publish-error.log` |
| 数据库 | 服务器上无 sqlite3 命令，查表结构用 node + `require('./db')` 写临时脚本到 /tmp 执行后删除 |

⚠️ 注意：`deploy.bat` 里写的 `SERVER_DIR=/dc-publish` 与 pm2 实际运行目录不一致，是历史遗留。部署一律用 `/root/Overseas-Community-Monitor`。

## 认证方式

优先 SSH 密钥（本机 `~/.ssh/id_ed25519` 的公钥已加入服务器 authorized_keys），密码只是回退：`.env` 里的 `SERVER_PASS`（.env 已被 gitignore）。脚本：[scripts/remote-exec.js](scripts/remote-exec.js)。

缺 ssh2 依赖时先装（不写入 package.json）：
```bash
npm.cmd install ssh2 --no-save
```

## 部署流程

```bash
# 1. 本地提交并推送
git add <改动文件>; git commit -m "<说明>"; git push origin main

# 2. 拉代码 + 重启（在项目根目录执行）
node .qoder/skills/deploy-prod/scripts/remote-exec.js "cd /root/Overseas-Community-Monitor && git pull origin main && pm2 restart dc-publish && sleep 5 && tail -n 20 /root/.pm2/logs/dc-publish-out.log"

# 3. 检查启动日志：出现"✅ 数据库初始化完成"即成功；有报错再看 error 日志
node .qoder/skills/deploy-prod/scripts/remote-exec.js "tail -n 40 /root/.pm2/logs/dc-publish-error.log"
```

## 部署后验证

- 静态页面/前端 JS：pull 即生效 + 浏览器强制刷新（Ctrl+F5）
- Node 后端代码：必须 pm2 restart 后才生效
- 数据库表结构变更：代码里走 db.js 的 `ALTER TABLE ... try/catch` 自动迁移模式，重启时自动执行
- 涉及页面行为时，用 Browser 子代理或让用户实际操作确认，不能只看日志

## 常见情况

- **SSH 认证失败**：密钥被回收时，让用户提供密码，用 remote-exec.js 把 `~/.ssh/id_ed25519.pub` 追加进服务器 `~/.ssh/authorized_keys`（加前 grep 防重复，加后 chmod 600）
- **重启后服务挂了**：`pm2 logs dc-publish --lines 50 --nostream` 看报错，常见是语法错误导致 502
- **查线上某接口报错**：直接 tail error 日志，报错带文件行号
