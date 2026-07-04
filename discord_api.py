#!/usr/bin/env python3
"""
Node.js 调用的 Discord API 代理脚本（安全增强版）
用法: python discord_api.py <send|recall|fetch|channel> ...
输出: JSON {"ok": true/false, "message_id": "...", "error": "..."}

安全特性:
- 从环境变量读取 Token（不在命令行中暴露）
- 文件路径验证（防止路径遍历攻击）
- 输入验证（Discord ID 格式检查）
- 资源清理（确保文件句柄正确关闭）
- 错误信息脱敏（不暴露敏感信息）
"""
import sys
import json
import os
import re
import logging
import requests
import tempfile
from contextlib import ExitStack

# ===== 配置 =====
PROXY_URL = os.environ.get('DISCORD_PROXY_URL', 'http://netproxy.ejoy.com:23198')
PROXIES = {"https": PROXY_URL, "http": PROXY_URL}
UPLOAD_DIR = os.path.abspath(os.environ.get('DISCORD_UPLOAD_DIR', os.path.join(os.path.dirname(__file__), 'uploads')))

# ===== 日志配置 =====
log_dir = os.path.join(os.path.dirname(__file__), 'logs')
os.makedirs(log_dir, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S',
    handlers=[
        logging.FileHandler(os.path.join(log_dir, 'discord_api.log')),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# ===== 验证规则 =====
DISCORD_ID_PATTERN = re.compile(r'^\d{17,19}$')
MAX_CONTENT_LENGTH = 2000

# 特殊频道：第一行单独作为标题，正文从第二行开始计算字数
TITLE_FIRST_LINE_CHANNELS = {
    '1238410997421838389',  # 日服-公告发布频道
}

def validate_discord_id(id_str, name="ID"):
    """验证 Discord ID 格式"""
    if not DISCORD_ID_PATTERN.match(str(id_str)):
        raise ValueError(f"无效的 Discord {name}: {id_str}（应为 17-19 位数字）")

def validate_file_path(file_path):
    """验证文件路径是否在允许的目录内"""
    abs_path = os.path.abspath(file_path)
    if not (abs_path.startswith(UPLOAD_DIR + os.sep) or abs_path == UPLOAD_DIR):
        raise ValueError(f"非法文件路径: {file_path}")
    if not os.path.isfile(abs_path):
        raise FileNotFoundError(f"文件不存在: {abs_path}")
    return abs_path

def sanitize_error_message(status_code, response_text):
    """脱敏错误信息"""
    error_map = {
        400: "请求参数错误",
        401: "Token 无效或过期",
        403: "权限不足，请检查 Bot 是否已邀请到服务器并授予足够权限",
        404: "频道或消息不存在",
        429: "请求频率过高，请稍后重试",
        500: "Discord 服务器内部错误",
        502: "Discord 服务暂时不可用",
        503: "Discord 服务维护中",
    }
    
    friendly_msg = error_map.get(status_code, f"未知错误 (HTTP {status_code})")
    logger.error(f"Discord API 错误 {status_code}: {response_text[:500]}")
    
    return friendly_msg

def send(channel_id, content, image_paths=None, server='TC'):
    """发送消息（从环境变量读取 Token）"""
    # 从环境变量读取 Token
    token = os.environ.get(f"DISCORD_{server}_BOT_TOKEN", "")
    if not token:
        print(json.dumps({"ok": False, "error": f"Token 未配置: DISCORD_{server}_BOT_TOKEN"}))
        return
    
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages"
    headers = {
        "Authorization": f"Bot {token}",
    }

    try:
        # 验证输入
        validate_discord_id(channel_id, "频道ID")
        
        # 超过字数限制 → 自动转txt附件发送
        txt_file_path = None
        if content and channel_id in TITLE_FIRST_LINE_CHANNELS:
            # 特殊频道：第一行当标题，正文从第二行开始计算
            lines = content.split('\n', 1)
            title_line = lines[0]
            body = lines[1] if len(lines) > 1 else ''
            if body and len(body) > MAX_CONTENT_LENGTH:
                logger.info(f"[公告频道] 正文超过{MAX_CONTENT_LENGTH}字（{len(body)}字），正文转txt附件")
                fd, txt_file_path = tempfile.mkstemp(suffix='.txt', prefix='dc_notice_')
                with os.fdopen(fd, 'w', encoding='utf-8') as f:
                    f.write(body)
                content = title_line  # 只保留第一行作为标题
                if image_paths:
                    image_paths = [txt_file_path] + list(image_paths)
                else:
                    image_paths = [txt_file_path]
        elif content and len(content) > MAX_CONTENT_LENGTH:
            # 普通频道：整篇超过2000字转txt
            logger.info(f"内容超过{MAX_CONTENT_LENGTH}字（{len(content)}字），转为txt附件发送")
            fd, txt_file_path = tempfile.mkstemp(suffix='.txt', prefix='dc_msg_')
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                f.write(content)
            content = f"📄 消息内容较长（{len(content)}字），已转为txt附件发送"
            if image_paths:
                image_paths = [txt_file_path] + list(image_paths)
            else:
                image_paths = [txt_file_path]
        
        if image_paths:
            # 有附件 → multipart
            files = []
            file_objects = []
            try:
                for i, fp in enumerate(image_paths):
                    # 验证路径安全性
                    if fp == txt_file_path:
                        safe_path = txt_file_path
                    else:
                        safe_path = validate_file_path(fp)
                    fname = os.path.basename(safe_path)
                    f = open(safe_path, "rb")
                    file_objects.append(f)
                    files.append((f"files[{i}]", (fname, f)))
                
                resp = requests.post(url, headers=headers, data={"content": content}, 
                                   files=files, proxies=PROXIES, timeout=60)
            finally:
                # 确保所有文件都被关闭
                for f in file_objects:
                    try:
                        f.close()
                    except:
                        pass
                # 清理临时txt文件
                if txt_file_path and os.path.exists(txt_file_path):
                    try:
                        os.remove(txt_file_path)
                    except:
                        pass
        else:
            # 纯文字
            resp = requests.post(url, headers=headers, json={"content": content}, proxies=PROXIES, timeout=30)

        if resp.status_code == 200:
            data = resp.json()
            logger.info(f"发送成功: 频道 {channel_id}, 消息ID {data.get('id', '')}")
            print(json.dumps({"ok": True, "message_id": data.get("id", "")}))
        else:
            error_msg = sanitize_error_message(resp.status_code, resp.text)
            print(json.dumps({"ok": False, "error": error_msg}))
    except Exception as e:
        logger.error(f"发送异常: {str(e)}")
        print(json.dumps({"ok": False, "error": str(e)}))

def recall(channel_id, message_id, server='TC'):
    """撤回消息（从环境变量读取 Token）"""
    # 从环境变量读取 Token
    token = os.environ.get(f"DISCORD_{server}_BOT_TOKEN", "")
    if not token:
        print(json.dumps({"ok": False, "error": f"Token 未配置: DISCORD_{server}_BOT_TOKEN"}))
        return
    
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages/{message_id}"
    headers = {
        "Authorization": f"Bot {token}",
    }
    try:
        # 验证输入
        validate_discord_id(channel_id, "频道ID")
        validate_discord_id(message_id, "消息ID")
        
        resp = requests.delete(url, headers=headers, proxies=PROXIES, timeout=15)
        if resp.status_code in (200, 204, 404):
            logger.info(f"撤回成功: 频道 {channel_id}, 消息ID {message_id}")
            print(json.dumps({"ok": True}))
        else:
            error_msg = sanitize_error_message(resp.status_code, resp.text)
            print(json.dumps({"ok": False, "error": error_msg}))
    except Exception as e:
        logger.error(f"撤回异常: {str(e)}")
        print(json.dumps({"ok": False, "error": str(e)}))

def fetch_msg(channel_id, message_id, server='TC'):
    """获取消息（从环境变量读取 Token）"""
    token = os.environ.get(f"DISCORD_{server}_BOT_TOKEN", "")
    if not token:
        print(json.dumps({"error": f"Token 未配置: DISCORD_{server}_BOT_TOKEN"}))
        return
    
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages/{message_id}"
    headers = {
        "Authorization": f"Bot {token}",
    }
    try:
        validate_discord_id(channel_id, "频道ID")
        validate_discord_id(message_id, "消息ID")
        
        resp = requests.get(url, headers=headers, proxies=PROXIES, timeout=15)
        if resp.status_code == 200:
            print(resp.text)
        else:
            error_msg = sanitize_error_message(resp.status_code, resp.text)
            print(json.dumps({"error": error_msg}))
    except Exception as e:
        logger.error(f"获取消息异常: {str(e)}")
        print(json.dumps({"error": str(e)}))

def fetch_channel(channel_id, server='TC'):
    """获取频道信息（从环境变量读取 Token）"""
    token = os.environ.get(f"DISCORD_{server}_BOT_TOKEN", "")
    if not token:
        print(json.dumps({"error": f"Token 未配置: DISCORD_{server}_BOT_TOKEN"}))
        return
    
    url = f"https://discord.com/api/v10/channels/{channel_id}"
    headers = {
        "Authorization": f"Bot {token}",
    }
    try:
        validate_discord_id(channel_id, "频道ID")
        
        resp = requests.get(url, headers=headers, proxies=PROXIES, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            print(json.dumps({"name": data.get("name", ""), "topic": data.get("topic", "")}))
        else:
            error_msg = sanitize_error_message(resp.status_code, resp.text)
            print(json.dumps({"error": error_msg}))
    except Exception as e:
        logger.error(f"获取频道异常: {str(e)}")
        print(json.dumps({"error": str(e)}))

def fetch_messages(server, channel_id, limit=50):
    """获取频道最近消息列表"""
    token = os.environ.get(f"DISCORD_{server}_BOT_TOKEN", "")
    if not token:
        print(json.dumps({"error": f"Token 未配置: DISCORD_{server}_BOT_TOKEN"}))
        return
    
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages?limit={limit}"
    headers = {
        "Authorization": f"Bot {token}",
    }
    try:
        validate_discord_id(channel_id, "频道ID")
        
        resp = requests.get(url, headers=headers, proxies=PROXIES, timeout=30)
        if resp.status_code == 200:
            messages = resp.json()
            # 返回简化版消息列表
            result = []
            for msg in messages:
                result.append({
                    "id": msg.get("id"),
                    "content": msg.get("content", ""),
                    "timestamp": msg.get("timestamp"),
                    "author": {
                        "username": msg.get("author", {}).get("username", ""),
                        "global_name": msg.get("author", {}).get("global_name"),
                        "bot": msg.get("author", {}).get("bot", False)
                    }
                })
            print(json.dumps(result, ensure_ascii=False))
        else:
            error_msg = sanitize_error_message(resp.status_code, resp.text)
            print(json.dumps({"error": error_msg}))
    except Exception as e:
        logger.error(f"获取消息异常: {str(e)}")
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: discord_api.py <send|recall|fetch|channel> ..."}))
        sys.exit(1)

    action = sys.argv[1]

    if action == "send" and len(sys.argv) >= 5:
        server = sys.argv[2]  # 新增：第一个参数是 server
        channel_id = sys.argv[3]
        content = sys.argv[4]
        images = sys.argv[5].split(",") if len(sys.argv) > 5 and sys.argv[5] else None
        send(channel_id, content, images, server)

    elif action == "recall" and len(sys.argv) >= 5:
        server = sys.argv[2]
        channel_id = sys.argv[3]
        message_id = sys.argv[4]
        recall(channel_id, message_id, server)

    elif action == "fetch" and len(sys.argv) >= 5:
        server = sys.argv[2]
        channel_id = sys.argv[3]
        message_id = sys.argv[4]
        fetch_msg(channel_id, message_id, server)

    elif action == "channel" and len(sys.argv) >= 4:
        server = sys.argv[2]
        channel_id = sys.argv[3]
        fetch_channel(channel_id, server)

    elif action == "fetch_messages" and len(sys.argv) >= 5:
        server = sys.argv[2]
        channel_id = sys.argv[3]
        limit = sys.argv[4] if len(sys.argv) > 4 else "50"
        fetch_messages(server, channel_id, limit)

    else:
        print(json.dumps({"error": f"Unknown action or missing args: {action}"}))
