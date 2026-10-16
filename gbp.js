// ============================================================
// Google ビジネスプロフィール 週2回投稿（LINE承認制）
//
// 流れ
//   1. GitHub Actions が火・金の朝に POST /cron/gbp-draft を呼ぶ
//   2. スプレッドシート「GBP投稿」タブの未使用記事を1件選び、
//      Claude API で Google 用の短文に要約
//   3. スタッフ（ADMIN_USER_IDS）へ LINE で投稿案＋承認ボタンを送信
//   4. 「承認して投稿」→ Google Business Profile API で投稿
//      「作り直す」→ 再生成 / 「スキップ」→ この記事は使わない
//
// 環境変数（Render.com）
//   ANTHROPIC_API_KEY   : 要約用 Claude API キー
//   GBP_CLAUDE_MODEL    : 任意（既定 claude-sonnet-5-5）
//   CRON_SECRET         : /cron/gbp-draft を呼ぶ側と共有する合言葉
//   GBP_CLIENT_ID / GBP_CLIENT_SECRET / GBP_REFRESH_TOKEN : Google OAuth
//   GBP_ACCOUNT_ID / GBP_LOCATION_ID : 投稿先（数字のID）
//   GBP_DEFAULT_URL     : ボタンの遷移先（既定 https://creacross.jp/）
//   ※ GBP_* が未設定の間は「テスト動作」になり、Googleには投稿しません
// ============================================================

const crypto = require('crypto');
const { google } = require('googleapis');

const GBP_SHEET = 'GBP投稿';
const HEADERS = [
  'ID', 'タイトル', '元文章（マイベストプロ等）', '参考URL', '状態',
  '投稿文（Google用）', '生成日時', '投稿日時', '備考'
];
const COL = { id: 'A', title: 'B', source: 'C', url: 'D', status: 'E', summary: 'F', generatedAt: 'G', postedAt: 'H', note: 'I' };

const ST = { READY: '未着手', WAIT: '承認待ち', DONE: '投稿済', SKIP: 'スキップ', ERROR: 'エラー' };

const SUMMARY_MAX = 1500;   // Google側の上限
const SUMMARY_TARGET = 500; // 狙いの文字数
const LOW_STOCK = 2;        // ネタの残りがこれ以下なら通知

// 宅建業法（誇大広告）・景表法・Googleのスパム判定を意識したNG表現
const NG_WORDS = ['絶対', '100%', '必ず売', '確実に売', '最安', '日本一', 'No.1', 'ナンバーワン', '業界初', '今だけ', '格安', '損をしない'];

const jstNow = () => new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

// ── 投稿文のチェック（問題点の一覧を返す。空なら問題なし） ──
function validateSummary(text) {
  const problems = [];
  if (!text) return ['本文が空です'];
  if (text.length > SUMMARY_MAX) problems.push(`${SUMMARY_MAX}文字を超えています（${text.length}文字）`);
  if (/https?:\/\/|www\./i.test(text)) problems.push('URLが含まれています');
  if (/0\d{1,4}[-ー−\s]?\d{1,4}[-ー−\s]?\d{3,4}/.test(text.normalize('NFKC'))) problems.push('電話番号らしき数字が含まれています');
  const hit = NG_WORDS.filter(w => text.includes(w));
  if (hit.length) problems.push(`広告表現として避けたい語があります：${hit.join('、')}`);
  return problems;
}

const SYSTEM_PROMPT = `あなたは大阪市西区の不動産会社（株式会社クレアクロス）のGoogleビジネスプロフィール投稿の編集者です。
マイベストプロ等に掲載した売却・相続のコラムを、Googleビジネスプロフィールの「最新情報」投稿用に短く書き直します。

【書き方】
- 日本語で${SUMMARY_TARGET}字前後（最大700字）
- 冒頭1〜2行で「誰の・どんな悩みに・何が分かるか」を伝える（検索結果では冒頭しか見えない）
- 短い段落と改行で、スマホで読みやすく。見出し記号や装飾は使わない
- 絵文字は使っても2個まで
- 最後は「詳しくは下のボタンからご覧ください」など、ボタンへ誘導する一文で締める
- お客さま目線のやさしく丁寧な文体。専門用語には一言添える

【守ること】
- 元文章に書かれていない事実・数字・制度名・日付を足さない（創作禁止）
- 法律・税金の内容は一般的な説明にとどめ、「個別の事情により異なります」「専門家（司法書士・税理士など）への確認も大切です」の趣旨を自然に入れる
- 「絶対」「必ず売れる」「最安」「日本一」「今だけ」など断定・誇大・煽りの表現は使わない
- 電話番号・URL・メールアドレスは本文に入れない（ボタンで誘導するため）
- 他社・他人への批判、個人が特定できる情報は入れない

出力は投稿本文のみ。前置き・説明・引用符・コードブロックは付けないこと。`;

function createGbp({ app, sheets, spreadsheetId, adminUserIds, pushMessage, replyMessage }) {
  const env = process.env;
  const CRON_SECRET = env.CRON_SECRET || '';
  const DEFAULT_URL = env.GBP_DEFAULT_URL || 'https://creacross.jp/';
  const MODEL = env.GBP_CLAUDE_MODEL || 'claude-sonnet-5-5';
  const gbpConfigured = !!(env.GBP_CLIENT_ID && env.GBP_CLIENT_SECRET && env.GBP_REFRESH_TOKEN &&
                           env.GBP_ACCOUNT_ID && env.GBP_LOCATION_ID);

  let sheetReady = false;
  const inFlight = new Set(); // 承認ボタンの連打・二重投稿防止

  // ── スプレッドシート ──
  async function ensureSheet() {
    if (sheetReady) return;
    const ss = await sheets.spreadsheets.get({ spreadsheetId });
    const names = ss.data.sheets.map(s => s.properties.title);
    if (!names.includes(GBP_SHEET)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: GBP_SHEET } } }] }
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${GBP_SHEET}'!A1:I1`,
        valueInputOption: 'RAW',
        requestBody: { values: [HEADERS] }
      });
      console.log(`「${GBP_SHEET}」タブを作成しました`);
    }
    sheetReady = true;
  }

  async function readRows() {
    await ensureSheet();
    const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${GBP_SHEET}'!A2:I` });
    return (r.data.values || []).map((v, i) => ({
      row: i + 2,
      id: (v[0] || '').trim(),
      title: v[1] || '',
      source: v[2] || '',
      url: (v[3] || '').trim(),
      status: (v[4] || '').trim(),
      summary: v[5] || ''
    }));
  }

  async function updateRow(row, patch) {
    const data = Object.entries(patch).map(([key, value]) => ({
      range: `'${GBP_SHEET}'!${COL[key]}${row}`,
      values: [[value]]
    }));
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data }
    });
  }

  const isReady = r => r.source.trim() && (r.status === '' || r.status === ST.READY);
  const findById = (rows, id) => rows.find(r => r.id === id);

  // ── Claude で要約 ──
  async function callClaude(row, feedback) {
    if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY が未設定です');
    let content = `【元のコラム】\nタイトル：${row.title || '（なし）'}\n\n<column>\n${row.source}\n</column>`;
    if (feedback) content += `\n\n【前回の案の問題点。直して書き直してください】\n${feedback}`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }]
      }),
      signal: AbortSignal.timeout(90000)
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
      .replace(/^```\w*\n?|```$/g, '').trim();
  }

  // 生成→チェック→問題があれば1回だけ直させる
  async function generateSummary(row) {
    let text = await callClaude(row);
    let problems = validateSummary(text);
    if (problems.length) {
      text = await callClaude(row, problems.join('\n'));
      problems = validateSummary(text);
    }
    return { text, problems };
  }

  // ── LINE への投稿案送信 ──
  function approvalMessages(row, text, problems, extra) {
    const head = ['📝 Googleビジネスプロフィール投稿案', row.title ? `元記事：${row.title}` : ''].filter(Boolean).join('\n');
    const messages = [
      { type: 'text', text: `${head}\n\n━━━━━━━━\n${text}\n━━━━━━━━\n（${text.length}文字）` }
    ];
    const notes = [];
    if (problems.length) notes.push(`⚠️ 自動チェックで気になる点があります。内容をよく確認してください\n・${problems.join('\n・')}`);
    if (!gbpConfigured) notes.push('ℹ️ Google接続が未設定のため、承認しても実際には投稿されません（テスト動作）');
    if (extra) notes.push(extra);
    if (notes.length) messages.push({ type: 'text', text: notes.join('\n\n') });
    messages.push({
      type: 'template',
      altText: 'Google投稿案の承認をお願いします',
      template: {
        type: 'buttons',
        text: 'この内容でGoogleに投稿しますか？',
        actions: [
          { type: 'postback', label: '承認して投稿', data: `gbp=approve&id=${row.id}`, displayText: '承認して投稿' },
          { type: 'postback', label: '作り直す', data: `gbp=redo&id=${row.id}`, displayText: '作り直す' },
          { type: 'postback', label: 'この記事はスキップ', data: `gbp=skip&id=${row.id}`, displayText: 'この記事はスキップ' }
        ]
      }
    });
    return messages;
  }

  const pushAdmins = messages => Promise.all(adminUserIds.map(id => pushMessage(id, messages)));

  // ── 投稿案の作成（cron / #gbp案 から呼ぶ） ──
  async function createDraftAndNotify() {
    if (adminUserIds.length === 0) throw new Error('ADMIN_USER_IDS が未設定です');
    const rows = await readRows();

    // 承認待ちが残っていれば、新しく作らずリマインドだけ
    const waiting = rows.find(r => r.status === ST.WAIT && r.summary);
    if (waiting) {
      await pushAdmins([
        { type: 'text', text: '⏰ 前回の投稿案がまだ承認待ちです。承認・作り直し・スキップのいずれかをお願いします。' },
        ...approvalMessages(waiting, waiting.summary, validateSummary(waiting.summary))
      ]);
      return { result: 'reminded', id: waiting.id };
    }

    const candidates = rows.filter(isReady);
    if (candidates.length === 0) {
      await pushAdmins([{ type: 'text', text: '📭 Google投稿のネタが尽きています。スプレッドシート「GBP投稿」タブに、マイベストプロの記事文を追加してください。' }]);
      return { result: 'no-stock' };
    }

    const row = candidates[0];
    if (!row.id) {
      row.id = crypto.randomBytes(3).toString('hex');
      await updateRow(row.row, { id: row.id });
    }
    const { text, problems } = await generateSummary(row);
    await updateRow(row.row, { status: ST.WAIT, summary: text, generatedAt: jstNow(), note: problems.join(' / ') });

    const remain = candidates.length - 1;
    const extra = remain <= LOW_STOCK ? `📦 ネタの残りは あと${remain}本 です。追加をお願いします。` : '';
    await pushAdmins(approvalMessages(row, text, problems, extra));
    return { result: 'drafted', id: row.id };
  }

  // ── Google Business Profile への投稿 ──
  async function postToGoogle(text, url) {
    const oauth2 = new google.auth.OAuth2(env.GBP_CLIENT_ID, env.GBP_CLIENT_SECRET);
    oauth2.setCredentials({ refresh_token: env.GBP_REFRESH_TOKEN });
    const { token } = await oauth2.getAccessToken();
    const res = await fetch(
      `https://mybusiness.googleapis.com/v4/accounts/${env.GBP_ACCOUNT_ID}/locations/${env.GBP_LOCATION_ID}/localPosts`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          languageCode: 'ja',
          summary: text,
          topicType: 'STANDARD',
          callToAction: { actionType: 'LEARN_MORE', url }
        }),
        signal: AbortSignal.timeout(30000)
      }
    );
    if (!res.ok) throw new Error(`GBP API ${res.status}: ${(await res.text()).slice(0, 400)}`);
    return res.json(); // { name, searchUrl, ... }
  }

  // ── LINE の Postback（承認ボタン） ──
  function parseData(data) {
    const o = {};
    (data || '').split('&').forEach(p => { const [k, v] = p.split('='); if (k) o[k] = decodeURIComponent(v || ''); });
    return o;
  }

  // 処理したら true を返す（index.js 側はそれ以降の処理をスキップ）
  async function handlePostback(event) {
    const params = parseData(event.postback && event.postback.data);
    if (!params.gbp) return false;

    const senderId = event.source && event.source.userId;
    const reply = text => replyMessage(event.replyToken, [{ type: 'text', text }]);
    if (!adminUserIds.includes(senderId)) {
      console.log(`[GBP] 管理者以外の操作を無視: ${senderId}`);
      return true;
    }

    const { gbp: action, id } = params;
    if (inFlight.has(id)) { await reply('⏳ 処理中です。少しお待ちください。'); return true; }
    inFlight.add(id);
    try {
      const rows = await readRows();
      const row = findById(rows, id);
      if (!row) { await reply('⚠️ 該当の投稿案が見つかりません（シートの行が削除された可能性があります）。'); return true; }
      if (row.status !== ST.WAIT) { await reply(`この投稿案はすでに処理済みです（状態：${row.status || '−'}）。`); return true; }

      if (action === 'skip') {
        await updateRow(row.row, { status: ST.SKIP, note: `スキップ ${jstNow()}` });
        await reply('⏭ この記事はスキップしました。次回は別の記事で案を作ります。');
      } else if (action === 'redo') {
        const { text, problems } = await generateSummary(row);
        await updateRow(row.row, { summary: text, generatedAt: jstNow(), note: problems.join(' / ') });
        await replyMessage(event.replyToken, approvalMessages(row, text, problems).slice(0, 5));
      } else if (action === 'approve') {
        if (validateSummary(row.summary).some(p => p.includes('文字を超'))) {
          await reply('⚠️ 文字数が上限を超えているため投稿できません。「作り直す」を押してください。');
          return true;
        }
        if (!gbpConfigured) {
          await reply('✅ 承認を受け付けました（テスト動作：Google接続が未設定のため、実際の投稿は行っていません）。');
          return true;
        }
        const url = /^https:\/\//.test(row.url) ? row.url : DEFAULT_URL;
        try {
          const post = await postToGoogle(row.summary, url);
          await updateRow(row.row, { status: ST.DONE, postedAt: jstNow(), note: post.searchUrl || post.name || '' });
          await reply(`✅ Googleビジネスプロフィールに投稿しました。${post.searchUrl ? `\n${post.searchUrl}` : ''}`);
        } catch (err) {
          console.error('[GBP] 投稿失敗:', err);
          await updateRow(row.row, { status: ST.ERROR, note: String(err.message).slice(0, 400) });
          await reply(`❌ 投稿に失敗しました。二重投稿を防ぐため自動再試行はしていません。\nGoogleビジネスプロフィールで投稿状況を確認し、必要ならシートの状態を「未着手」に戻してください。\n\n${String(err.message).slice(0, 200)}`);
        }
      }
    } catch (err) {
      console.error('[GBP] Postback処理エラー:', err);
      await reply('⚠️ 処理中にエラーが発生しました。時間をおいてもう一度お試しください。');
    } finally {
      inFlight.delete(id);
    }
    return true;
  }

  // ── 定期実行用エンドポイント（GitHub Actions から呼ぶ） ──
  const safeEqual = (a, b) => {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  app.post('/cron/gbp-draft', async (req, res) => {
    if (!CRON_SECRET || !safeEqual(req.get('x-cron-secret') || '', CRON_SECRET)) {
      return res.status(401).json({ status: 'unauthorized' });
    }
    try {
      res.json({ status: 'ok', ...(await createDraftAndNotify()) });
    } catch (err) {
      console.error('[GBP] 投稿案の作成に失敗:', err);
      await pushAdmins([{ type: 'text', text: `⚠️ Google投稿案の作成に失敗しました。\n${String(err.message).slice(0, 200)}` }]).catch(() => {});
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // スタッフが手動で今すぐ案を作る（#gbp案）
  async function handleCommand(event, senderId, text) {
    if (text !== '#gbp案') return false;
    if (!adminUserIds.includes(senderId)) return false;
    await replyMessage(event.replyToken, [{ type: 'text', text: '📝 投稿案を作成します。少しお待ちください。' }]);
    try {
      await createDraftAndNotify();
    } catch (err) {
      console.error('[GBP] #gbp案 失敗:', err);
      await pushMessage(senderId, [{ type: 'text', text: `⚠️ 投稿案の作成に失敗しました。\n${String(err.message).slice(0, 200)}` }]);
    }
    return true;
  }

  console.log(`GBP投稿機能：${gbpConfigured ? 'Google接続あり' : 'テスト動作（Google接続未設定）'}`);
  return { handlePostback, handleCommand, validateSummary };
}

module.exports = { createGbp, validateSummary };
