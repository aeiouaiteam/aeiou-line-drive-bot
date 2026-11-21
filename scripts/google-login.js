// One-time Google sign-in for the bot, run on the owner's own computer:
//   node scripts/google-login.js <client_id> <client_secret>
// Opens the browser, the owner clicks "Allow", and the refresh token the bot
// needs is saved to .secrets/google.json (git-ignored, never printed).
//
// Needs an OAuth client of type "Desktop app". Scopes asked:
//   drive.file     - create and edit only the files this bot itself creates
//   drive.readonly - read the docs the assistant writes for the bot to send

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error('Usage: node scripts/google-login.js <client_id> <client_secret>');
  process.exit(1);
}

const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.readonly'];
const OUT = path.join(__dirname, '..', '.secrets', 'google.json');

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  // Failing to open is fine: the URL is printed for the owner to open by hand.
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

const server = http.createServer();
server.listen(0, '127.0.0.1', () => {
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  // prompt=consent makes Google return a refresh token every time, not only on first sign-in.
  const url = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

  server.on('request', async (req, res) => {
    const params = new URL(req.url, redirectUri).searchParams;
    if (!params.has('code') && !params.has('error')) return res.end();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    try {
      if (params.has('error')) throw new Error(params.get('error'));
      const { tokens } = await oauth.getToken(params.get('code'));
      if (!tokens.refresh_token) throw new Error('Google did not return a refresh token');
      // Google lets the owner untick individual permissions; the bot needs both.
      const missing = SCOPES.filter((s) => !(tokens.scope || '').split(' ').includes(s));
      if (missing.length) throw new Error(`ยังอนุญาตไม่ครบ กรุณารันใหม่แล้วติ๊กอนุญาตทุกข้อ (missing: ${missing.join(', ')})`);
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify({ clientId, clientSecret, refreshToken: tokens.refresh_token }, null, 2));
      res.end('<h2>เรียบร้อย ✅ ปิดหน้านี้แล้วกลับไปที่ Claude ได้เลย</h2>');
      console.log(`OK - saved to ${OUT}`);
      server.close();
    } catch (err) {
      res.end(`<h2>ไม่สำเร็จ: ${err.message}</h2>`);
      console.error(`FAILED - ${err.message}`);
      server.close(() => process.exit(1));
    }
  });

  console.log(`Open this link to allow access (it should open by itself):\n${url}\n\nWaiting for approval...`);
  openBrowser(url);
});
