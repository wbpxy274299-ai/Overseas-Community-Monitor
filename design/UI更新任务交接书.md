# 任务：把已定稿的新 UI 设计应用到 M2G 运营后台线上系统

## 背景
M2G 用户运营后台（线上地址 test-posting.xyz，代码仓库 github.com/wbpxy274299-ai/Overseas-Community-Monitor）的 UI 已完成全新设计并定稿（黑白未来感风格，含日/夜双主题）。设计稿是静态样板，现在需要你把它安全地应用到线上真实系统。**核心原则：换皮不换骨——只改外观，绝不破坏数据填充和功能逻辑。**

## 关键材料
1. **设计预览（V42 定稿）**：https://idealab.alibaba-inc.com/ideatalk/static-pages/m2g-design-preview-4ppnjv4r/ （含全部 9 个页面的新设计，顶部有日/夜主题切换）
2. **完整设计稿源文件**：`m2g-design-preview-v42.html`（可直接打开查看每页的完整 HTML/CSS 实现）
3. **已抽取的主题样式**：`m2g-theme.css`（**必须用 V44 版**，文件头有版本标注；含浮动反馈组件样式 + 「线上兼容覆盖层」——覆盖原站残留的蓝色下划线链接、无层次表格等默认样式。若线上夜间模式仍出现蓝色下划线链接，说明部署的是旧版主题文件，重新上传本文件即可，无需改任何 HTML/JS，无需重启服务，浏览器强刷生效）
4. **设计规范**：`M2G运营后台UI设计规范.md`（每页改造基准、组件规范、双主题色值令牌）
5. **部署指南**：`M2G部署上线指南.md`（备份/上传/接入/回滚指令）

## 线上系统信息
- 服务器：198.13.60.172（Ubuntu，项目在 `/dc-publish/`，PM2 管理进程 dc-publish，Nginx 反代 80→5000）
- 技术栈：Node.js，模板用 `{#xxx}` 占位符动态填数据，前端逻辑在 `public/js/*.js` 和各 views 内联 script
- 页面清单：登录(google-login.html) / 发布首页(index.html) / 舆情(sentiment.html) / 周报(weekly-report.html, reports.html) / 洞察(insights.html) / 术语校对(terminology.html) / 贴文助手(post-assistant.html) / 权限管理(admin.html) / 历史数据(sentiment-history.html)

## 执行步骤（严格按序）
1. **备份**：`cp -r /dc-publish /dc-publish_backup_$(date +%Y%m%d_%H%M%S)`，备份成功前不做任何修改
2. **路径 A 先上（低风险换肤）**：把 `m2g-theme.css` 放到 `/dc-publish/public/css/`，在每个 `views/*.html` 的 `</head>` 前加一行 `<link rel="stylesheet" href="/css/m2g-theme.css">`，`pm2 restart dc-publish` 后验证
3. **路径 B 逐页重构（高还原）**：按 登录→发布首页→舆情→周报→洞察→术语→贴文→权限→历史数据 的顺序，逐页把模板 HTML 结构改成设计稿的结构
4. **每改一页**：`pm2 restart dc-publish` → 打开该页验证数据正常、功能可用、日夜主题切换正常 → 通过后 `git commit` 一次再改下一页
5. **全部完成后** `git push`

## 红线（违反即回滚）
- ❌ 禁止用设计稿 HTML 整体覆盖 views/*.html
- ❌ 禁止删除或改动任何 `{#xxx}` 占位符、JS 数据加载逻辑、`getElementById` 用到的元素 id
- ❌ 禁止未备份就改文件、禁止一次改多页
- ✅ 回滚方式：`rm -rf /dc-publish && mv /dc-publish_backup_xxx /dc-publish`；或路径 A 只删 link 引用那一行

## 验收标准
- 每个页面视觉与设计预览 V42 一致（结构、黑白节奏、组件样式）
- 所有动态数据正常显示（占位符全部接好，无冻死数据）
- 所有按钮/表单/上传/切换功能正常
- 日间/夜间双主题均正常
- 回滚方案经过实际验证可用

## 附加组件：全站浮动反馈按钮（必做）
每个页面右下角加一个浮动反馈按钮（黑色圆角方块 + 对话气泡图标，位于"回到顶部"按钮上方），点击弹出反馈小窗，内容包含：
- 描述 textarea（占位文案：详细描述你遇到的问题或建议…）
- 称呼 input（必填）
- 「提交给管理员」主按钮
提交逻辑调用现有后端 `POST /api/feedback`，请求体 `{title, content}`（title 用「玩家反馈 · 称呼」拼接，content 为描述；与 routes/feedback.js 的字段一致，需登录态）。
样式已包含在 `m2g-theme.css` 末尾（`.fb-fab` / `.fb-win` 等类），HTML 结构与交互函数见 `m2g-design-preview-v43.html` 底部「浮动反馈组件」注释块，直接复制到公共模板片段即可。
注意：线上原有的 FeedbackBtn（public/js/common.js）可保留或替换，二选一，不要出现两个反馈入口。

## 附加组件：报告阅读器（查看完整报告弹窗，必做）
05 周报管理、06 玩家洞察的「查看完整报告 / 查看」必须打开**报告阅读器弹窗**，不要把报告正文直接渲染在页面上（当前线上把整篇报告平铺在页面里，页面过长、无法快速浏览，必须改）。

阅读器结构（HTML/CSS/JS 见 `m2g-design-preview-v45.html` 与 `m2g-theme.css` 末尾「报告阅读器」段）：
- 固定头部：报告标题 + 周期/生成时间/数据来源 + 关闭 ×
- 章节导航条：点击平滑滚动到对应章节（`rptGo(id)`）
- 可滚动正文：总览统计卡（`.rpt-stat`）+ 情绪电量条（`.mood`）+ 话题卡（`.rpt-topic`）+ 原声引用（`.quote`）+ 总结块（`.sumbox`）
- 底部操作栏：复制总结 / 下载报告
- 交互函数：`openRpt(id)` / `closeRpt(id)` / `rptGo(id)`，点遮罩或 × 关闭

**两个已知线上 bug 必须一并修复：**
1. `<br>` 标签以原始文本泄漏（如「—— ちほろーい <br>[中文翻译]」）。原因：后端把换行存成字面 `<br>` 文本又被二次转义。修复：前端渲染报告内容前，把字面 `&lt;br&gt;` / `<br>` 字符串替换为 `\n`，并对正文块启用 `white-space:pre-line`（主题 CSS 已含 `.rpt-body .quote,.rpt-body .sumbox{white-space:pre-line}`）
2. 06 页黑面板在有报告时应显示「查看完整报告」主按钮 + 统计卡（54/51/3/周期），不要再显示「还没有洞察报告」空状态

## 交付物
- 重构后的全部 views/*.html 模板
- 更新说明（每页改了什么、保留了什么）
- git 提交记录
