#!/bin/bash
echo "============================================"
echo "  游戏术语校对工具 - 启动中..."
echo "============================================"
echo ""

# 尝试 Python3
if command -v python3 &>/dev/null; then
    echo "[OK] 找到 Python3，启动本地服务..."
    python3 -m http.server 8080 &
    sleep 1
    open "http://localhost:8080" 2>/dev/null || xdg-open "http://localhost:8080" 2>/dev/null
    echo "浏览器已打开 http://localhost:8080"
    echo "按 Ctrl+C 停止服务"
    wait
    exit 0
fi

# 尝试 Python
if command -v python &>/dev/null; then
    echo "[OK] 找到 Python，启动本地服务..."
    python -m http.server 8080 &
    sleep 1
    open "http://localhost:8080" 2>/dev/null || xdg-open "http://localhost:8080" 2>/dev/null
    echo "浏览器已打开 http://localhost:8080"
    echo "按 Ctrl+C 停止服务"
    wait
    exit 0
fi

# 尝试 Node.js
if command -v npx &>/dev/null; then
    echo "[OK] 找到 Node.js，启动本地服务..."
    npx http-server -p 8080 -o
    exit 0
fi

echo "[ERROR] 未找到 Python 或 Node.js"
echo "请安装 Python 后重试"
exit 1
