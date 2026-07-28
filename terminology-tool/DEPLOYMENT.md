# 术语校对工具 - Vercel 部署指南

## 快速开始

### 1. 推送到 GitHub

双击 `push.bat`，代码会自动推送到 GitHub。

### 2. 连接 Vercel

1. 打开 https://vercel.com
2. 用 GitHub 账号登录
3. 点击 "Add New Project"
4. 选择你的仓库：`terminology-tool`
5. Framework Preset 选择 **Other**
6. 点击 "Deploy"

### 3. 绑定自定义域名

1. 在 Vercel 项目设置中，找到 "Domains"
2. 添加你的域名：`test-posting.xyz`
3. Vercel 会给你 DNS 配置信息

### 4. 配置 DNS（阿里云）

登录阿里云控制台，进入域名解析：

1. 添加 CNAME 记录：
   - 记录类型：CNAME
   - 主机记录：@
   - 记录值：`cname.vercel-dns.com`

2. 如果需要 www：
   - 记录类型：CNAME
   - 主机记录：www
   - 记录值：`cname.vercel-dns.com`

### 5. 等待生效

DNS 配置通常需要 5-30 分钟生效。

## 本地开发

双击 `start.bat` 启动本地服务器，访问 `http://localhost:8080`

## 文件结构

```
术语校对工具/
├── api/
│   └── proxy.js              # Vercel Serverless Function
├── data/
│   ├── terms.json            # 术语数据
│   └── version.json          # 版本信息
├── src/
│   ├── css/                  # 样式文件
│   └── js/                   # JavaScript 文件
├── index.html                # 主页面
├── vercel.json               # Vercel 配置
├── start.bat                 # 本地启动脚本
└── push.bat                  # GitHub 推送脚本
```

## API 代理原理

`/api/proxy` 是一个 Serverless Function，作用是：
- 接收前端的翻译请求
- 转发到 AI Studio API
- 返回结果给前端
- 解决浏览器的 CORS 跨域限制

## 注意事项

1. **VPN 要求**：同事需要连接公司 VPN 才能访问 AI Studio API
2. **域名备案**：如果域名指向国内服务器需要备案，Vercel 海外节点不需要
3. **HTTPS**：Vercel 自动提供 HTTPS，无需额外配置
