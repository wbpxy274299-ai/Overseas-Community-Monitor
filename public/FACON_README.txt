# 🍭 火焰小精灵 Favicon 安装指引

## 已完成的修改（代码层）
- ✅ 所有 9 个 HTML 页面的 favicon 引用已替换为 `/favicon-fire-spirit.png`
- ✅ Title 中的 emoji 图标已移除，符合 M2G UI 设计规范

## 需要操作的步骤

### 方法 1：手动放置图片（推荐）
1. **保存图片**：将你的火焰小精灵图片保存为 `favicon-fire-spirit.png`
2. **上传到服务器**：放在项目的 `public/` 目录下
3. **重启服务**：
   ```bash
   pm2 restart dc-publish
   ```
4. **刷新浏览器**：Ctrl + F5

### 方法 2：通过 Git 同步
1. **保存图片**：将图片放到 `public/favicon-fire-spirit.png`
2. **添加到 Git**：
   ```bash
   git add public/favicon-fire-spirit.png
   git commit -m "新增全站 favicon:火焰小精灵"
   git push
   ```
3. **在服务器上拉取**：
   ```bash
   cd /path/to/Overseas-Community-Monitor
   git pull
   pm2 restart dc-publish
   ```

## 当前使用的页面列表
- views/admin.html ✓
- views/index.html ✓
- views/sentiment.html ✓
- views/insights.html ✓
- views/post-assistant.html ✓
- views/terminology.html ✓
- views/reports.html ✓
- views/sentiment-history.html ✓
- views/weekly-report.html ✓

## 参考图片
原始图片由用户提供，是一只可爱的橙黄色火焰小精灵（类似原神火元素生物）。

---
最后更新：2026-08-06 by AI Agent
