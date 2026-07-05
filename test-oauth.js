require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { OAuth2Client } = require('google-auth-library');

const oauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_CALLBACK_URL || 'http://localhost:5000/api/auth/google/callback'
);

console.log('Client ID:', oauth2Client.clientId_);
console.log('Client Secret:', oauth2Client.clientSecret_ ? '已设置' : '未设置');
console.log('Redirect URI:', oauth2Client.redirectUri_);

const scopes = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: scopes,
  prompt: 'consent'
});

console.log('\n生成的授权 URL:');
console.log(authUrl);
