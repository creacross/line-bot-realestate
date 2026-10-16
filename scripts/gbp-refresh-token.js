// Google ビジネスプロフィール用の refresh token を取得する（最初に1回だけ、手元のPCで実行）
//
//   GBP_CLIENT_ID=xxx GBP_CLIENT_SECRET=yyy node scripts/gbp-refresh-token.js
//
// 事前に Google Cloud Console で「OAuthクライアントID（デスクトップアプリ or ウェブ）」を作り、
// ウェブの場合は承認済みリダイレクトURIに http://localhost:3939/callback を登録しておく。
// 表示されたURLをブラウザで開き、投稿先店舗の「オーナー/管理者」のGoogleアカウントで許可する。

const http = require('http');
const { google } = require('googleapis');

const { GBP_CLIENT_ID, GBP_CLIENT_SECRET } = process.env;
if (!GBP_CLIENT_ID || !GBP_CLIENT_SECRET) {
  console.error('GBP_CLIENT_ID と GBP_CLIENT_SECRET を環境変数で指定してください');
  process.exit(1);
}

const REDIRECT = 'http://localhost:3939/callback';
const oauth2 = new google.auth.OAuth2(GBP_CLIENT_ID, GBP_CLIENT_SECRET, REDIRECT);
const url = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // refresh token を確実に発行させる
  scope: ['https://www.googleapis.com/auth/business.manage']
});

http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== '/callback') { res.end(); return; }
  try {
    const { tokens } = await oauth2.getToken(u.searchParams.get('code'));
    res.end('OK。ターミナルに戻ってください。このタブは閉じて構いません。');
    console.log('\n--- Render の環境変数 GBP_REFRESH_TOKEN に登録する値（他人に見せないこと）---\n');
    console.log(tokens.refresh_token || '（発行されませんでした。Googleアカウントの「サードパーティのアクセス」で本アプリを削除してやり直してください）');
  } catch (e) {
    res.end('エラー');
    console.error(e.message);
  }
  process.exit(0);
}).listen(3939, () => {
  console.log('次のURLをブラウザで開いてください：\n\n' + url + '\n');
});
