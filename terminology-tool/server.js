/**
 * 本地代理服务器 - Node.js 版本
 * 绕过 CORS 限制，转发 API 请求到 AI Studio
 * 运行方式: node server.js
 * 然后访问: http://localhost:8080
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8080;
const AI_STUDIO_BASE = "https://aistudio.alibaba-inc.com/api/aiapp/run";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// 从 config.json 读取 API Key
let config = {};
try {
  config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
} catch (e) {
  console.log('Warning: config.json not found or invalid');
}

// MIME 类型映射
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStaticFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not Found');
      } else {
        res.writeHead(500);
        res.end('Server Error: ' + err.code);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
}

function handleProxy(req, res, body) {
  try {
    const data = JSON.parse(body);
    const type = data.type || 'gemini'; // 'gemini' 或 'aistudio'
    const question = data.question || '';

    if (type === 'gemini') {
      // 调用 Gemini API
      const apiKey = config.gemini?.apiKey || '';
      const model = config.gemini?.model || 'gemini-pro';
      
      if (!apiKey) {
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ error: 'Gemini API Key not configured' }));
        return;
      }

      const apiUrl = `${GEMINI_ENDPOINT}/${model}:generateContent?key=${apiKey}`;
      
      // 构建请求内容，支持图片和文本
      const parts = [];
      
      // 如果有图片，添加图片数据
      if (data.image && data.image.data) {
        parts.push({
          inline_data: {
            mime_type: data.image.mimeType || 'image/jpeg',
            data: data.image.data
          }
        });
      }
      
      // 添加文本
      parts.push({ text: question });
      
      const payload = JSON.stringify({
        contents: [{
          parts: parts
        }]
      });

      const parsedUrl = new URL(apiUrl);
      const options = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const apiReq = https.request(options, (apiRes) => {
        let result = '';
        apiRes.on('data', (chunk) => { result += chunk; });
        apiRes.on('end', () => {
          try {
            const geminiResponse = JSON.parse(result);
            const text = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({
              success: true,
              data: { content: text }
            }));
          } catch (e) {
            res.writeHead(500, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ error: 'Failed to parse Gemini response' }));
          }
        });
      });

      apiReq.on('error', (e) => {
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ error: e.message }));
      });

      apiReq.write(payload);
      apiReq.end();

    } else {
      // 调用 AI Studio API
      const code = data.code || '';
      const version = data.version || '1.0.0';
      const ak = data.apiKey || '';

      const apiUrl = `${AI_STUDIO_BASE}/${code}/${version}`;
      const payload = JSON.stringify({
        empId: '000000',
        question: question,
        sessionId: 'proxy-' + Date.now(),
        stream: false
      });

      const parsedUrl = new URL(apiUrl);
      const options = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'X-AK': ak,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const apiReq = https.request(options, (apiRes) => {
        let result = '';
        apiRes.on('data', (chunk) => { result += chunk; });
        apiRes.on('end', () => {
          res.writeHead(apiRes.statusCode, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(result);
        });
      });

      apiReq.on('error', (e) => {
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ error: e.message }));
      });

      apiReq.write(payload);
      apiReq.end();
    }

  } catch (e) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ error: e.message }));
  }
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // 处理 CORS 预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // 处理 API 代理请求
  if (pathname === '/api/proxy' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      handleProxy(req, res, body);
    });
    return;
  }

  // 处理静态文件
  let filePath = '.' + pathname;
  if (filePath === './') {
    filePath = './index.html';
  }

  serveStaticFile(res, filePath);
});

// 启动服务器
server.listen(PORT, () => {
  const serverUrl = `http://localhost:${PORT}`;
  console.log('='.repeat(50));
  console.log('  Game Terminology Tool + Post Assistant');
  console.log(`  Open: ${serverUrl}`);
  console.log('  Press Ctrl+C to stop');
  console.log('='.repeat(50));

  // 自动打开浏览器
  const start = (process.platform === 'darwin' ? 'open' : 
                 process.platform === 'win32' ? 'start' : 'xdg-open');
  require('child_process').exec(`${start} ${serverUrl}`);
});
