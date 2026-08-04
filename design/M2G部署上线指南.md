# M2G 运营后台 · UI 上线部署指南

> 目标：把「黑白未来感」设计安全地应用到线上 test-posting.xyz
> 服务器：198.13.60.172（Ubuntu，项目目录 `/dc-publish/`，PM2 管理，Nginx 80→5000）
> 仓库：`wbpxy274299-ai/Overseas-Community-Monitor`

---

## 0. 必读：为什么不能"直接替换"

设计稿是静态样板间（数据是写死的样品）；线上是活程序（数据靠 `{#占位符}` 和 JS 动态填充）。
**直接覆盖 HTML = 数据冻死 + 功能失灵。** 正确做法是分层推进，先低风险后高还原。

---

## 1. 登录服务器（一切操作的前提）

在你自己的电脑终端里执行（替换为你的密钥路径；若用密码登录去掉 `-i` 那行）：

```bash
ssh root@198.13.60.172
```

> 之前我尝试连接被拒，说明服务器可能开了密钥登录或改了 SSH 端口。
> 若连接失败，先确认：`ssh -p 端口号 root@198.13.60.172`
> 或在 Vultr 控制台点「View Password / Access」获取登录方式。

进入服务器后，先定位项目：

```bash
cd /dc-publish && ls
pm2 list                 # 确认 dc-publish 进程在跑
```

---

## 2. 第一步永远是：备份（无论走哪条路径）

```bash
cd /dc-publish
# 备份时间戳
TS=$(date +%Y%m%d_%H%M%S)
# 备份整个项目（含 views 和 css）
cp -r /dc-publish /dc-publish_backup_$TS
echo "已备份到 /dc-publish_backup_$TS"
```

**只有备份成功，才继续往下做。** 回滚就是 `rm -rf /dc-publish && mv /dc-publish_backup_xxx /dc-publish`。

---

## 路径 A：主题皮肤覆盖（推荐先做，低风险）

**原理**：把设计稿里的「颜色/字体/圆角/按钮风格」抽成一个 `m2g-theme.css`，在每个页面的 `</head>` 前加一行引用。不动任何 HTML 结构，数据逻辑零影响，删掉那一行就回滚。

### A1. 上传主题文件到服务器

把 `m2g-theme.css`（我已在 files 目录生成好）传上去：

```bash
# 在你本地电脑执行（不是在服务器上）
scp m2g-theme.css root@198.13.60.172:/dc-publish/public/css/m2g-theme.css
```

### A2. 在每个页面模板里加一行引用

在服务器上，对每个 `views/*.html` 文件，在 `</head>` 前面加这一行：

```html
  <link rel="stylesheet" href="/css/m2g-theme.css">
</head>
```

用 `sed` 批量加（自动在每个 html 的 `</head>` 前插入）：

```bash
cd /dc-publish/views
for f in *.html; do
  sed -i 's#</head>#  <link rel="stylesheet" href="/css/m2g-theme.css">\n</head>#' "$f"
  echo "已处理: $f"
done
```

### A3. 重启并验证

```bash
pm2 restart dc-publish
pm2 logs dc-publish --lines 20     # 看有没有报错
```

打开 test-posting.xyz，强制刷新（Ctrl+Shift+R）。

### A4. 万一不对，一键回滚

```bash
cd /dc-publish/views
# 把刚加的那行删掉
sed -i '/<link rel="stylesheet" href="\/css\/m2g-theme.css">/d' *.html
pm2 restart dc-publish
```

> 路径 A 结束：配色、字体、按钮质感会变，但布局结构还是原来的。
> 如果效果满意，到此即可；如果还想要设计稿的布局，继续路径 B。

---

## 路径 B：完整模板重构（高还原，需逐页改）

**原理**：按设计稿重写每个 `views/*.html` 的 HTML 结构，**但保留所有 `{#占位符}` 和 `<script>` 数据逻辑不动**。这是真正"完美替换"，但需要逐页手工改，不能一键。

### B1. 建议的推进顺序（从最常用、最简单的开始）

1. 登录页 `google-login.html`（最简单，先练手）
2. 发布首页 `index.html`
3. 舆情监控 `sentiment.html`
4. 周报管理 `weekly-report.html` / `reports.html`
5. 其余页面

### B2. 单页改造的标准动作（每页都这样做）

以某一页为例：

```bash
cd /dc-publish/views
cp index.html index.html.bak        # 改之前先备份单页
```

然后打开设计稿对应页面（`m2g-design-preview-v42.html` 里的第 N 页），把它的 HTML 结构复制过来，但执行三条铁律：

1. **所有 `{#xxx}` 占位符原样保留**，位置对应到设计稿里的展示处
2. **底部 `<script>` 数据加载逻辑整段照抄**，一个函数都不删
3. **元素 `id` 与 JS 里 `getElementById('xxx')` 用到的保持一致**

### B3. 每改一页立即验证

```bash
pm2 restart dc-publish
# 浏览器打开该页，确认：数据正常加载、按钮能点、日夜主题切换正常
```

### B4. 全部改完后，同步推回 GitHub

```bash
cd /dc-publish
git add -A
git commit -m "feat: 应用黑白未来感 UI 主题（路径B 完整重构）"
git push origin main
```

---

## 3. 强烈建议：先 A 后 B

1. **今天**：走路径 A，半小时内全站换肤，先让团队看到新风格、确认方向
2. **确认后**：按路径 B 逐页精修布局，一次改一页、测一页、过一页
3. **每页改完**：`git commit` 一次，出问题能精确回退到某一页之前

---

## 4. 安全红线（任何时候都别碰）

- ❌ 不要用设计稿 HTML 整体覆盖 `views/*.html`（会丢 `{#占位符}` 和 JS）
- ❌ 不要删 `{#...}` 占位符或改动底部 `<script>` 数据逻辑
- ❌ 不要在没备份前改任何文件
- ❌ 不要一次性改所有页面，逐页改逐页测
- ✅ 每改一步先 `cp` 备份，每改一页先 `pm2 restart` 验证

---

## 5. 需要我协助时

- 想要某页的「设计稿 HTML → 接入占位符后的成品模板」，把该页的线上截图或 `views/xxx.html` 发我，
  我直接产出可粘贴的模板代码（占位符已接好）
- 服务器 SSH 连不上时，把 `pm2 list` 或报错截图发我，我帮你定位

---

*设计基准版本：V42 · 设计规范见《M2G运营后台UI设计规范.md》*
