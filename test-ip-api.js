const http = require('http');

console.log('通过服务器 IP 测试 API...\n');

// 使用服务器 IP 地址测试
const req = http.get('http://198.13.60.172:5000/api/auth/google/login', (res) => {
  let data = '';
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    console.log('状态码:', res.statusCode);
    console.log('\n响应内容:');
    
    try {
      const json = JSON.parse(data);
      if (json.authUrl) {
        const url = new URL(json.authUrl);
        const clientId = url.searchParams.get('client_id');
        const redirectUri = url.searchParams.get('redirect_uri');
        
        console.log('client_id:', clientId || '❌ 空');
        console.log('redirect_uri:', redirectUri || '❌ 空');
        
        if (!clientId || !redirectUri) {
          console.log('\n❌ 问题确认：通过 IP 访问时 client_id 或 redirect_uri 为空');
          console.log('   这说明服务器代码有问题，需要重启服务器');
        } else {
          console.log('\n✅ 通过 IP 访问也正常');
        }
      } else {
        console.log(data);
      }
    } catch (e) {
      console.log('不是 JSON 格式');
      console.log(data.substring(0, 500));
    }
  });
});

req.on('error', (err) => {
  console.error('请求失败:', err.message);
});

req.end();
