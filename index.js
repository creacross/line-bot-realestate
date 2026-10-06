// ============================================================
// 不動産 初期対応 LINE Bot（Node.js / Render.com版）
// Google スプレッドシート連携 + 手動/Bot切り替え機能
//
// 【2026-09 改修内容】
//  1. 会話ステート（モード含む）をスプレッドシート「モード管理」タブに保存
//     → Render.com の再起動・スリープ後も手動モードが維持される
//  2. 手動モード中は「相談したい」でもBotを再開しない
//     → Bot再開はスタッフコマンド「#bot再開」のみ
//  3. スタッフコマンドは「管理者のLINEから、対象お客さまのIDを指定」する方式に変更
//     （旧仕様では送信したスタッフ自身のモードが切り替わっていた）
//  4. 応答メッセージ（キーワード応答）用のキーワードにはBotが反応しない
//  5. ヒアリング外のメッセージにはBotは返信せず、手動対応へ引き継ぐ
//  6. Webhook の署名検証を追加（なりすまし防止）
//  7. ヒアリング完了時に ADMIN_USER_IDS のスタッフへ新着通知（プッシュ）を送信
//
// 【Render.com に追加する環境変数】
//  ADMIN_USER_IDS   : スタッフのLINE User ID（複数はカンマ区切り）
//                     → スタッフが自分のLINEから「#myid」と送ると確認できる
//  IGNORE_KEYWORDS  : Botが無視するキーワード（複数はカンマ区切り）
//                     → LINE公式の応答メッセージで使っているキーワードを入れる
// ============================================================

const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const { createGbp } = require('./gbp');
const app = express();

// ── 環境変数から設定を読み込み ──
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '';
const PORT = process.env.PORT || 3000;

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
// 全角/半角の違いを吸収して比較する（「１」と「1」、「，」と「,」などを同一視）
const normalize = s => (s || '').normalize('NFKC').trim();
const IGNORE_KEYWORDS = [...new Set(
  normalize(process.env.IGNORE_KEYWORDS)
    .split(/[,、\n]/).map(s => s.trim()).filter(Boolean)
)];

const HEARING_SHEET = '顧客ヒアリング';
const STATE_SHEET = 'モード管理';

// ── Google Sheets API 認証セットアップ ──
let sheets = null;
try {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheets = google.sheets({ version: 'v4', auth });
  console.log('Google Sheets API: 認証成功');
} catch (err) {
  console.error('Google Sheets API: 認証失敗', err.message);
}

// ── JSONボディを受け取る設定（署名検証用に生データも保持） ──
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 会話ステート管理（メモリ＋スプレッドシート永続化）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const userStates = {};     // userId → state（キャッシュ）
const stateRowIndex = {};  // userId → スプレッドシートの行番号
let stateSheetReady = false;
let writeChain = Promise.resolve(); // 書き込みを1件ずつ順番に処理する

function defaultState() {
  return { step: 'NONE', answers: {}, mode: 'bot', manualGreeted: false };
}

function getUserState(userId) {
  const s = userStates[userId];
  return s ? JSON.parse(JSON.stringify(s)) : defaultState();
}

function setUserState(userId, state) {
  userStates[userId] = state;
  persistState(userId);
}

function setManualMode(userId, { greeted = false } = {}) {
  const state = getUserState(userId);
  state.mode = 'manual';
  state.manualGreeted = greeted; // 手動モード切替後の初回メッセージフラグ
  state.step = 'NONE';
  state.answers = {};
  setUserState(userId, state);
}

function setBotMode(userId) {
  const state = getUserState(userId);
  state.mode = 'bot';
  state.manualGreeted = false;
  state.step = 'NONE';
  state.answers = {};
  setUserState(userId, state);
}

function isManualMode(userId) {
  return getUserState(userId).mode === 'manual';
}

async function ensureStateSheet() {
  if (stateSheetReady) return;
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const names = spreadsheet.data.sheets.map(s => s.properties.title);
  if (!names.includes(STATE_SHEET)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: STATE_SHEET } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${STATE_SHEET}'!A1:D1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['LINE User ID', 'モード', '状態データ（編集しないでください）', '更新日時']] }
    });
    console.log(`「${STATE_SHEET}」タブを作成しました`);
  }
  stateSheetReady = true;
}

// 起動時にスプレッドシートから全ユーザーの状態を読み込む
async function loadStates() {
  if (!sheets || !SPREADSHEET_ID) {
    console.warn('スプレッドシート未設定：モードはメモリのみで管理されます（再起動で消えます）');
    return;
  }
  try {
    await ensureStateSheet();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${STATE_SHEET}'!A2:C`
    });
    const rows = res.data.values || [];
    rows.forEach((row, i) => {
      const userId = row[0];
      if (!userId) return;
      try {
        userStates[userId] = { ...defaultState(), ...JSON.parse(row[2] || '{}') };
        stateRowIndex[userId] = i + 2;
      } catch (e) {
        console.error(`状態データの読み込み失敗（${userId}）`, e.message);
      }
    });
    console.log(`モード管理：${Object.keys(userStates).length}件の状態を読み込みました`);
  } catch (err) {
    console.error('モード管理の読み込みエラー:', err.message);
  }
}

function persistState(userId) {
  if (!sheets || !SPREADSHEET_ID) return;
  writeChain = writeChain
    .then(() => saveStateToSheet(userId))
    .catch(err => console.error('モード管理の保存エラー:', err.message));
}

async function saveStateToSheet(userId) {
  await ensureStateSheet();
  const state = userStates[userId];
  if (!state) return;
  const timestamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const row = [userId, state.mode === 'manual' ? '手動' : 'Bot', JSON.stringify(state), timestamp];

  const rowNum = stateRowIndex[userId];
  if (rowNum) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${STATE_SHEET}'!A${rowNum}:D${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });
  } else {
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${STATE_SHEET}'!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    });
    const m = (res.data.updates && res.data.updates.updatedRange || '').match(/![A-Z]+(\d+)/);
    if (m) stateRowIndex[userId] = parseInt(m[1], 10);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 顧客ヒアリング結果の書き込み
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function writeToSheet(data) {
  if (!sheets || !SPREADSHEET_ID) {
    console.log('スプレッドシート未設定のためスキップ');
    return;
  }

  try {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetNames = spreadsheet.data.sheets.map(s => s.properties.title);

    if (!sheetNames.includes(HEARING_SHEET)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: HEARING_SHEET } } }] }
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${HEARING_SHEET}'!A1`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [['受付日時', 'LINE User ID', 'お名前', '目的', 'エリア', '予算', '間取り', '希望利回り', '検討時期', '自由入力', 'ステータス']]
        }
      });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${HEARING_SHEET}'!A1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          data.timestamp, data.userId, data.name, data.purpose, data.area,
          data.budget, data.layout, data.yield, data.timing, data.freeText, data.status
        ]]
      }
    });

    console.log('スプレッドシートに記録完了');
  } catch (err) {
    console.error('スプレッドシート書き込みエラー:', err.message);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ヘルスチェック
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/', (req, res) => {
  res.status(200).send('LINE Bot is running.');
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Webhook 署名検証
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function verifySignature(req) {
  if (!LINE_CHANNEL_SECRET) {
    console.warn('LINE_CHANNEL_SECRET 未設定のため署名検証をスキップ');
    return true;
  }
  const signature = req.get('x-line-signature');
  if (!signature || !req.rawBody) return false;
  const expected = crypto
    .createHmac('sha256', LINE_CHANNEL_SECRET)
    .update(req.rawBody)
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Webhook エントリーポイント
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) {
    console.error('署名不一致：LINE以外からのリクエスト、またはLINE_CHANNEL_SECRETの設定ミス');
    return res.status(401).json({ status: 'invalid signature' });
  }
  res.status(200).json({ status: 'ok' });

  const events = req.body.events || [];

  for (const event of events) {
    try {
      // ── 友だち追加 ──
      if (event.type === 'follow') {
        await handleFollow(event);
        continue;
      }

      const userId = event.source ? event.source.userId : null;
      if (!userId) continue;

      // ── テキストメッセージ ──
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();

        // ① 自分のUser ID確認（管理者登録用）
        if (text === '#myid') {
          await replyMessage(event.replyToken, [
            { type: 'text', text: `あなたのLINE User ID：\n${userId}` }
          ]);
          continue;
        }

        // ①-2 Google投稿案をいま作る（管理者のみ）
        if (await gbp.handleCommand(event, userId, text)) continue;

        // ② スタッフコマンド（管理者のみ有効）
        if (text.startsWith('#')) {
          const handled = await handleStaffCommand(event, userId, text);
          if (handled) continue;
        }

        // ③ 応答メッセージ（キーワード応答）用のキーワードはBotが反応しない
        if (IGNORE_KEYWORDS.includes(normalize(text))) {
          console.log(`[除外キーワード] ${userId}: ${text}`);
          continue;
        }

        // ④ 手動モード中：何を送られても一切返信しない（「相談したい」も含む）
        if (isManualMode(userId)) {
          console.log(`[手動モード] ${userId} のメッセージをスキップ: ${text}`);
          continue;
        }

        // ⑤ Bot対応中の「相談したい」→ ヒアリング開始
        if (text === '相談したい' || text === '相談') {
          setUserState(userId, { ...defaultState(), step: 'SELECT_PURPOSE' });
          await replyMessage(event.replyToken, [purposeButtons()]);
          console.log(`[ヒアリング開始] ${userId}（相談したい）`);
          continue;
        }

        // ⑥ Bot対応中：通常のメッセージ処理
        await handleMessage(event);
        continue;
      }

      // ── Postback ──
      if (event.type === 'postback') {
        // Google投稿の承認ボタン（手動モードの影響を受けない）
        if (await gbp.handlePostback(event)) continue;
        if (isManualMode(userId)) {
          console.log(`[手動モード] ${userId} のPostbackをスキップ`);
          continue;
        }
        await handlePostback(event);
        continue;
      }

    } catch (err) {
      console.error('Error handling event:', err);
    }
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// スタッフコマンド
//   #対応開始 Uxxxxxxxx… → 指定したお客さまを手動対応に
//   #bot再開 Uxxxxxxxx…  → 指定したお客さまをBot対応に戻す
//   #状態確認 Uxxxxxxxx… → 指定したお客さまの状態を表示
//   お客さまのIDはスプレッドシートの「LINE User ID」列からコピー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleStaffCommand(event, senderId, text) {
  const [cmd, target] = text.split(/\s+/);
  const commands = ['#対応開始', '#bot再開', '#状態確認'];
  if (!commands.includes(cmd)) return false;

  if (!ADMIN_USER_IDS.includes(senderId)) {
    console.log(`[コマンド拒否] 管理者以外からのコマンド: ${senderId} ${cmd}`);
    return false; // お客さまが送った場合は通常メッセージとして扱う
  }

  if (!target || !/^U[0-9a-f]{32}$/.test(target)) {
    await replyMessage(event.replyToken, [{
      type: 'text',
      text: `⚠️ お客さまのUser IDを付けて送ってください。\n\n例：\n${cmd} U1234abcd...\n\nIDはスプレッドシートの「LINE User ID」列からコピーできます。`
    }]);
    return true;
  }

  if (cmd === '#対応開始') {
    setManualMode(target, { greeted: true });
    await replyMessage(event.replyToken, [{ type: 'text', text: `✅ 手動対応に切り替えました\n${target}` }]);
    console.log(`[モード切替] ${target} → 手動対応（by ${senderId}）`);
  } else if (cmd === '#bot再開') {
    setBotMode(target);
    await replyMessage(event.replyToken, [{
      type: 'text',
      text: `✅ Bot対応に戻しました\n${target}\n\nお客さまには通知されません。必要に応じて「相談したい」と送ると条件ヒアリングが始まる旨をお伝えください。`
    }]);
    console.log(`[モード切替] ${target} → Bot対応（by ${senderId}）`);
  } else if (cmd === '#状態確認') {
    const state = getUserState(target);
    const known = !!userStates[target];
    await replyMessage(event.replyToken, [{
      type: 'text',
      text: `📊 現在の状態\n${target}\n\nモード：${state.mode === 'manual' ? '手動対応中' : 'Bot対応中'}\nステップ：${state.step}` +
            (known ? '' : '\n（記録なし：未登録のIDです）')
    }]);
  }
  return true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 目的選択ボタン
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function purposeButtons() {
  return {
    type: 'template',
    altText: 'ご相談の目的を選んでください',
    template: {
      type: 'buttons',
      title: 'ご相談の目的',
      text: '当てはまるものをお選びください',
      actions: [
        { type: 'postback', label: '🏠 賃貸で探したい', data: 'purpose=賃貸' },
        { type: 'postback', label: '🏡 購入を検討したい', data: 'purpose=売買' },
        { type: 'postback', label: '📈 投資物件を探したい', data: 'purpose=投資' },
        { type: 'postback', label: '📋 その他のご相談', data: 'purpose=その他' }
      ]
    }
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 友だち追加時の処理
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleFollow(event) {
  const userId = event.source.userId;
  setUserState(userId, { ...defaultState(), step: 'SELECT_PURPOSE' });

  await replyMessage(event.replyToken, [
    {
      type: 'text',
      text: 'はじめまして！\n不動産についてのご相談、ありがとうございます。\n\nまずは簡単なご希望をお聞かせください。\n担当スタッフが最適なご提案をさせていただきます！'
    },
    purposeButtons()
  ]);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Postback（ボタン選択）の処理
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handlePostback(event) {
  const userId = event.source.userId;
  const state = getUserState(userId);
  const params = parsePostbackData(event.postback.data);

  if (params.purpose) {
    state.answers.purpose = params.purpose;

    if (params.purpose === 'その他') {
      state.step = 'FREE_TEXT_OTHER';
      setUserState(userId, state);
      await replyMessage(event.replyToken, [
        { type: 'text', text: 'ご相談内容を自由にご入力ください。' }
      ]);
      return;
    }

    state.step = 'ASK_AREA';
    setUserState(userId, state);
    await replyMessage(event.replyToken, [
      {
        type: 'text',
        text: `${params.purpose}ですね！承知しました。\n\nご希望のエリアを教えてください。\n（例：大阪市西区、吹田市、豊中市 など）`
      }
    ]);
    return;
  }

  const budget = params.budget_rent || params.budget_buy || params.budget_invest;
  if (budget) {
    state.answers.budget = budget;
    await proceedAfterBudget(event, userId, state);
    return;
  }

  if (params.yield) {
    state.answers.yield = params.yield;
    state.step = 'ASK_LAYOUT';
    setUserState(userId, state);
    await askLayout(event, state.answers.purpose);
    return;
  }

  if (params.layout) {
    state.answers.layout = params.layout;
    state.step = 'ASK_TIMING';
    setUserState(userId, state);
    await replyMessage(event.replyToken, [
      {
        type: 'template',
        altText: 'ご検討の時期を選んでください',
        template: {
          type: 'buttons',
          title: 'ご検討の時期',
          text: 'いつ頃をご希望ですか？',
          actions: [
            { type: 'postback', label: 'すぐにでも', data: 'timing=すぐにでも' },
            { type: 'postback', label: '1〜3ヶ月以内', data: 'timing=1〜3ヶ月以内' },
            { type: 'postback', label: '半年以内', data: 'timing=半年以内' },
            { type: 'postback', label: 'まだ情報収集中', data: 'timing=情報収集中' }
          ]
        }
      }
    ]);
    return;
  }

  if (params.timing) {
    state.answers.timing = params.timing;
    state.step = 'ASK_NAME';
    setUserState(userId, state);
    await replyMessage(event.replyToken, [
      {
        type: 'text',
        text: 'ありがとうございます！\n最後に、お名前をお聞かせいただけますか？\n（ニックネームでもOKです）'
      }
    ]);
    return;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// テキストメッセージの処理（Bot対応中）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();
  const state = getUserState(userId);

  switch (state.step) {
    case 'ASK_AREA':
      state.answers.area = text;
      state.step = 'ASK_BUDGET';
      setUserState(userId, state);
      await askBudget(event, state.answers.purpose);
      break;

    case 'FREE_TEXT_OTHER':
      state.answers.freeText = text;
      state.step = 'ASK_NAME';
      setUserState(userId, state);
      await replyMessage(event.replyToken, [
        {
          type: 'text',
          text: '承知しました！\nお名前をお聞かせいただけますか？\n（ニックネームでもOKです）'
        }
      ]);
      break;

    case 'ASK_NAME':
      state.answers.name = text;
      await completeHearing(event, userId, state);
      break;

    default:
      // ヒアリング外の自由メッセージ（リッチメニューの「★まずはご相談★」等を含む）
      // → Botは返信せず、黙って手動対応へ引き継ぐ
      //   （返信はLINE公式の応答メッセージ／スタッフに任せ、二重返信を防ぐ）
      setManualMode(userId, { greeted: true });
      console.log(`[自動切替] ${userId} → 手動対応（ヒアリング外メッセージ・返信なし）: ${text}`);
      break;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 予算の質問
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function askBudget(event, purpose) {
  let actions = [];

  if (purpose === '賃貸') {
    actions = [
      { type: 'postback', label: '〜8万円', data: 'budget_rent=〜8万円' },
      { type: 'postback', label: '8〜12万円', data: 'budget_rent=8〜12万円' },
      { type: 'postback', label: '12〜20万円', data: 'budget_rent=12〜20万円' },
      { type: 'postback', label: '20万円以上', data: 'budget_rent=20万円以上' }
    ];
  } else if (purpose === '売買') {
    actions = [
      { type: 'postback', label: '〜3,000万円', data: 'budget_buy=〜3000万円' },
      { type: 'postback', label: '3,000〜5,000万円', data: 'budget_buy=3000〜5000万円' },
      { type: 'postback', label: '5,000〜8,000万円', data: 'budget_buy=5000〜8000万円' },
      { type: 'postback', label: '8,000万円以上', data: 'budget_buy=8000万円以上' }
    ];
  } else if (purpose === '投資') {
    actions = [
      { type: 'postback', label: '〜2,000万円', data: 'budget_invest=〜2000万円' },
      { type: 'postback', label: '2,000〜5,000万円', data: 'budget_invest=2000〜5000万円' },
      { type: 'postback', label: '5,000万〜1億円', data: 'budget_invest=5000万〜1億円' },
      { type: 'postback', label: '1億円以上', data: 'budget_invest=1億円以上' }
    ];
  }

  const title = purpose === '賃貸' ? '月額家賃のご予算' :
                purpose === '投資' ? '投資予算' : '購入予算';

  await replyMessage(event.replyToken, [
    {
      type: 'template',
      altText: 'ご予算を選んでください',
      template: { type: 'buttons', title, text: 'ご予算の目安をお選びください', actions }
    }
  ]);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 予算回答後の分岐
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function proceedAfterBudget(event, userId, state) {
  if (state.answers.purpose === '投資') {
    state.step = 'ASK_YIELD';
    setUserState(userId, state);
    await replyMessage(event.replyToken, [
      {
        type: 'template',
        altText: '希望利回りを選んでください',
        template: {
          type: 'buttons',
          title: '希望利回り',
          text: 'ご希望の表面利回りは？',
          actions: [
            { type: 'postback', label: '4%以上', data: 'yield=4%以上' },
            { type: 'postback', label: '6%以上', data: 'yield=6%以上' },
            { type: 'postback', label: '8%以上', data: 'yield=8%以上' },
            { type: 'postback', label: 'こだわらない', data: 'yield=こだわらない' }
          ]
        }
      }
    ]);
  } else {
    state.step = 'ASK_LAYOUT';
    setUserState(userId, state);
    await askLayout(event, state.answers.purpose);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 間取りの質問
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function askLayout(event, purpose) {
  const actions = (purpose === '投資')
    ? [
        { type: 'postback', label: 'ワンルーム〜1K', data: 'layout=ワンルーム〜1K' },
        { type: 'postback', label: '1LDK〜2LDK', data: 'layout=1LDK〜2LDK' },
        { type: 'postback', label: '一棟もの', data: 'layout=一棟' },
        { type: 'postback', label: 'こだわらない', data: 'layout=こだわらない' }
      ]
    : [
        { type: 'postback', label: 'ワンルーム〜1K', data: 'layout=ワンルーム〜1K' },
        { type: 'postback', label: '1LDK〜2LDK', data: 'layout=1LDK〜2LDK' },
        { type: 'postback', label: '3LDK〜', data: 'layout=3LDK〜' },
        { type: 'postback', label: 'こだわらない', data: 'layout=こだわらない' }
      ];

  await replyMessage(event.replyToken, [
    {
      type: 'template',
      altText: '間取りを選んでください',
      template: { type: 'buttons', title: 'ご希望の間取り', text: '当てはまるものをお選びください', actions }
    }
  ]);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ヒアリング完了処理
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function completeHearing(event, userId, state) {
  const a = state.answers;
  const timestamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  const record = {
    timestamp,
    userId,
    name: a.name || '',
    purpose: a.purpose || '',
    area: a.area || '',
    budget: a.budget || '',
    layout: a.layout || '',
    yield: a.yield || '',
    timing: a.timing || '',
    freeText: a.freeText || '',
    status: '未対応'
  };

  await writeToSheet(record);

  console.log('=== 新規お問い合わせ ===');
  console.log(JSON.stringify(record, null, 2));

  // スタッフへ新着通知（失敗してもお客さまへの返信は止めない）
  await notifyStaff(record);

  await replyMessage(event.replyToken, [
    {
      type: 'text',
      text: `${a.name}様、ご回答ありがとうございます！\n\nいただいた内容をもとに、担当スタッフより\nご連絡させていただきます。\n\n少々お待ちくださいませ。\nお急ぎの場合はこちらにメッセージを\nお送りいただいても大丈夫です！`
    },
    {
      type: 'text',
      text: `📋 ご回答内容の確認\n\n` +
            `目的：${a.purpose || '−'}\n` +
            (a.area ? `エリア：${a.area}\n` : '') +
            (a.budget ? `予算：${a.budget}\n` : '') +
            (a.yield ? `希望利回り：${a.yield}\n` : '') +
            (a.layout ? `間取り：${a.layout}\n` : '') +
            (a.timing ? `検討時期：${a.timing}\n` : '') +
            (a.freeText ? `ご相談内容：${a.freeText}` : '')
    }
  ]);

  // ── ヒアリング完了後は自動で手動モードに切り替え（スプレッドシートにも保存） ──
  setManualMode(userId);
  console.log(`[自動切替] ${userId} → 手動対応モード（ヒアリング完了）`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LINE Messaging API へ返信
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function replyMessage(replyToken, messages) {
  try {
    const response = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({ replyToken, messages })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('LINE API Error:', response.status, errorBody);
    }
  } catch (err) {
    console.error('Reply failed:', err);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LINE Messaging API へプッシュ送信（スタッフ通知用）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function pushMessage(to, messages) {
  try {
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({ to, messages })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`LINE Push Error（${to}）:`, response.status, errorBody);
    }
  } catch (err) {
    console.error(`Push failed（${to}）:`, err);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 新規お問い合わせをスタッフ（ADMIN_USER_IDS）へ通知
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const URGENT_TIMINGS = ['すぐにでも', '1〜3ヶ月以内'];

function buildStaffNotice(record) {
  const urgent = URGENT_TIMINGS.includes(record.timing);
  const lines = [
    urgent ? '🔥 新規お問い合わせ（検討時期が近い方です）' : '🔔 新規お問い合わせ',
    '',
    `お名前：${record.name || '−'}`,
    `目的：${record.purpose || '−'}`
  ];
  if (record.area) lines.push(`エリア：${record.area}`);
  if (record.budget) lines.push(`予算：${record.budget}`);
  if (record.yield) lines.push(`希望利回り：${record.yield}`);
  if (record.layout) lines.push(`間取り：${record.layout}`);
  if (record.timing) lines.push(`検討時期：${record.timing}`);
  if (record.freeText) lines.push(`ご相談内容：${record.freeText}`);
  lines.push('', `受付：${record.timestamp}`, '詳細はスプレッドシート「顧客ヒアリング」をご確認ください。');
  return [
    { type: 'text', text: lines.join('\n') },
    // IDだけの別メッセージにして、長押しでそのままコピーできるようにする
    { type: 'text', text: `お客さまID（#対応開始 などのコマンド用）\n${record.userId}` }
  ];
}

async function notifyStaff(record) {
  if (ADMIN_USER_IDS.length === 0) {
    console.warn('ADMIN_USER_IDS 未設定のためスタッフ通知をスキップ');
    return;
  }
  const messages = buildStaffNotice(record);
  await Promise.all(ADMIN_USER_IDS.map(id => pushMessage(id, messages)));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ユーティリティ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parsePostbackData(dataStr) {
  const result = {};
  (dataStr || '').split('&').forEach(pair => {
    const [key, value] = pair.split('=');
    if (key && value) {
      result[decodeURIComponent(key)] = decodeURIComponent(value);
    }
  });
  return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Google ビジネスプロフィール投稿（gbp.js）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const gbp = createGbp({
  app, sheets, spreadsheetId: SPREADSHEET_ID, adminUserIds: ADMIN_USER_IDS, pushMessage, replyMessage
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// サーバー起動（状態を読み込んでから受付開始）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
loadStates().finally(() => {
  app.listen(PORT, () => {
    console.log(`LINE Bot server running on port ${PORT}`);
    console.log(`管理者登録数：${ADMIN_USER_IDS.length}件 / 除外キーワード：${IGNORE_KEYWORDS.join('、') || 'なし'}`);
    if (ADMIN_USER_IDS.length === 0) {
      console.warn('⚠️ ADMIN_USER_IDS 未設定：スタッフコマンドは使えません（#myid でID確認→Renderの環境変数に登録）');
    }
    console.log('=== 担当者コマンド（管理者のLINEから送信） ===');
    console.log('#対応開始 [お客さまID] → 手動対応に切り替え');
    console.log('#bot再開 [お客さまID]  → Bot対応に戻す');
    console.log('#状態確認 [お客さまID] → 状態を確認');
    console.log('#myid                  → 自分のUser IDを表示');
  });
});
