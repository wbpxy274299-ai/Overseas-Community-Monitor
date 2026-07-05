const http = require('http');

console.log('测试服务器环境变量...\n');

const req = http.get('http://localhost:5000/api/auth/google/login', (res) => {
  let data = '';
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    console.log('状态码:', res.statusCode);
    console.log('\n响应内容:');
    console.log(data);
  });
});

req.on('error', (err) => {
  console.error('请求失败:', err.message);
});

req.end();
