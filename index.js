// ============================================================
// 不動産 初期対応 LINE Bot（Node.js / Render.com版）
// ============================================================

const express = require('express');
const crypto = require('crypto');
const app = express();

// ── 環境変数から設定を読み込み（Render.comの管理画面で設定）──
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || '';
const PORT = process.env.PORT || 3000;

// ── JSONボディを受け取る設定 ──
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// ── ユーザーの会話ステート管理（メモリ内） ──
// ※ Render無料プランでは再起動でリセットされますが、
//    ヒアリングは数分で完了するので実用上問題ありません
const userStates = {};

function getUserState(userId) {
  return userStates[userId] || { step: 'NONE', answers: {} };
}

function setUserState(userId, state) {
  userStates[userId] = state;
}

function clearUserState(userId) {
  delete userStates[userId];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ヘルスチェック（Render.comの死活監視用）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/', (req, res) => {
  res.status(200).send('LINE Bot is running.');
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Webhook エントリーポイント
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/webhook', async (req, res) => {
  // まず200を返す（LINEのタイムアウト防止）
  res.status(200).json({ status: 'ok' });

  const events = req.body.events || [];

  for (const event of events) {
    try {
      if (event.type === 'follow') {
        await handleFollow(event);
      } else if (event.type === 'message' && event.message.type === 'text') {
        await handleMessage(event);
      } else if (event.type === 'postback') {
        await handlePostback(event);
      }
    } catch (err) {
      console.error('Error handling event:', err);
    }
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 友だち追加時の処理
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleFollow(event) {
  const userId = event.source.userId;
  setUserState(userId, { step: 'SELECT_PURPOSE', answers: {} });

  await replyMessage(event.replyToken, [
    {
      type: 'text',
      text: 'はじめまして！\n不動産についてのご相談、ありがとうございます。\n\nまずは簡単なご希望をお聞かせください。\n担当スタッフが最適なご提案をさせていただきます！'
    },
    {
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
    }
  ]);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Postback（ボタン選択）の処理
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handlePostback(event) {
  const userId = event.source.userId;
  const data = event.postback.data;
  const state = getUserState(userId);
  const params = parsePostbackData(data);

  // ── 目的の選択 ──
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
        text: `${params.purpose}ですね！承知しました。\n\nご希望のエリアを教えてください。\n（例：渋谷区、横浜市中区、埼玉県さいたま市 など）`
      }
    ]);
    return;
  }

  // ── 予算選択（賃貸） ──
  if (params.budget_rent) {
    state.answers.budget = params.budget_rent;
    await proceedAfterBudget(event, userId, state);
    return;
  }

  // ── 予算選択（売買） ──
  if (params.budget_buy) {
    state.answers.budget = params.budget_buy;
    await proceedAfterBudget(event, userId, state);
    return;
  }

  // ── 予算選択（投資） ──
  if (params.budget_invest) {
    state.answers.budget = params.budget_invest;
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
    return;
  }

  // ── 利回り選択（投資） ──
  if (params.yield) {
    state.answers.yield = params.yield;
    state.step = 'ASK_LAYOUT';
    setUserState(userId, state);
    await askLayout(event, state.answers.purpose);
    return;
  }

  // ── 間取り選択 ──
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

  // ── 時期選択 ──
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
// テキストメッセージの処理
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
      if (text === '相談したい' || text === '相談') {
        setUserState(userId, { step: 'SELECT_PURPOSE', answers: {} });
        await replyMessage(event.replyToken, [
          {
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
          }
        ]);
      } else {
        await replyMessage(event.replyToken, [
          {
            type: 'text',
            text: 'ご連絡ありがとうございます！\n「相談したい」と送っていただければ、\n最初からご案内をスタートします。'
          }
        ]);
      }
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
      template: {
        type: 'buttons',
        title: title,
        text: 'ご予算の目安をお選びください',
        actions: actions
      }
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
      template: {
        type: 'buttons',
        title: 'ご希望の間取り',
        text: '当てはまるものをお選びください',
        actions: actions
      }
    }
  ]);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ヒアリング完了処理
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function completeHearing(event, userId, state) {
  const a = state.answers;
  const now = new Date();
  const timestamp = now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  // ── コンソールに記録（Render.comのLogsで確認可能） ──
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
  console.log('=== 新規お問い合わせ ===');
  console.log(JSON.stringify(record, null, 2));

  // ── 担当者にメール通知（LINE Notify経由 or 外部メールサービス） ──
  // ※ 簡易版として、LINE Notifyで通知する仕組みを後から追加可能
  // ※ ここではコンソールログとLINEへの完了メッセージのみ

  // ── お客さまへ完了メッセージ ──
  await replyMessage(event.replyToken, [
    {
      type: 'text',
      text: `${a.name}様、ご回答ありがとうございます！\n\nいただいた内容をもとに、担当スタッフより\nご連絡させていただきます。\n\n少々お待ちくださいませ。\nお急ぎの場合はこちらにメッセージを\nお送りいただいても大丈夫です！`
    },
    {
      type: 'text',
      text: `📋 ご回答内容の確認\n\n` +
            `目的：${a.purpose || '−'}\n` +
            `エリア：${a.area || '−'}\n` +
            `予算：${a.budget || '−'}\n` +
            (a.yield ? `希望利回り：${a.yield}\n` : '') +
            `間取り：${a.layout || '−'}\n` +
            `検討時期：${a.timing || '−'}`
    }
  ]);

  clearUserState(userId);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LINE Messaging API へ返信
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function replyMessage(replyToken, messages) {
  const url = 'https://api.line.me/v2/bot/message/reply';

  try {
    const response = await fetch(url, {
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
// ユーティリティ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parsePostbackData(dataStr) {
  const result = {};
  dataStr.split('&').forEach(pair => {
    const [key, value] = pair.split('=');
    if (key && value) {
      result[decodeURIComponent(key)] = decodeURIComponent(value);
    }
  });
  return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// サーバー起動
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.listen(PORT, () => {
  console.log(`LINE Bot server running on port ${PORT}`);
});
