// ============================================================
// Google ビジネスプロフィール投稿用の「タイトル入りカード画像」を作る
//
//  - 1200×900（4:3）の PNG を、タイトルから自動生成
//  - 日本語フォントはパッケージ同梱の Noto Sans JP（Render にフォント不要）
//  - 画像のURLには署名を付け、他人が勝手に画像を作れないようにする
//
// 環境変数（任意）
//   GBP_IMAGE_LABEL  : 左上のラベル（既定「売却・相続コラム」）
//   GBP_IMAGE_FOOTER : 下部の社名（既定「株式会社クレアクロス」）
//   IMAGE_SECRET     : URL署名用の秘密（未設定なら CRON_SECRET を使う）
// ============================================================

const crypto = require('crypto');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const FONT_FILE = require.resolve('@expo-google-fonts/noto-sans-jp/700Bold/NotoSansJP_700Bold.ttf');
const FONT_FAMILY = 'Noto Sans JP';

const W = 1200;
const H = 900;
const PAD_X = 96;
const TITLE_MAX = 60;
const ALLOWED_WIDTHS = [480, 1200]; // 480 = LINEのプレビュー用（1MB以下に収める）

// 行頭に来てはいけない文字（禁則）
const NO_LINE_START = '、。，．？！）」』】〕ー…・：；';

const secret = () => process.env.IMAGE_SECRET || process.env.CRON_SECRET || '';
const imageEnabled = () => !!secret();

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// 全角=1、半角（英数・記号）=0.56 として幅を概算
const charWidth = ch => (/[ -~｡-ﾟ]/.test(ch) ? 0.56 : 1);

function normalizeTitle(title) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  if (Array.from(t).length > TITLE_MAX) t = Array.from(t).slice(0, TITLE_MAX - 1).join('') + '…';
  return t || 'ご相談ください';
}

// タイトルの長さに応じて文字サイズを決める
function pickFontSize(title) {
  const n = Array.from(title).reduce((sum, ch) => sum + charWidth(ch), 0);
  if (n <= 12) return 104;
  if (n <= 22) return 88;
  if (n <= 36) return 74;
  return 62;
}

// 禁則処理つきの折り返し（行数は最小にしつつ、各行の長さを揃える。句読点があれば優先して改行）
const BREAK_AFTER = '、。？！';

function wrap(title, size, maxWidth) {
  const chars = Array.from(title);
  const widths = chars.map(charWidth);
  const total = widths.reduce((a, b) => a + b, 0);
  const limit = maxWidth / size; // 1行に入る全角文字数
  const n = Math.max(1, Math.ceil(total / limit));
  const target = Math.min(limit, total / n + 1.2); // 行の長さを揃えるための目標幅

  const lines = [];
  let line = '';
  let width = 0;
  let used = 0; // これまでに使った幅
  chars.forEach((ch, i) => {
    const w = widths[i];
    if (width + w > target && line) {
      if (NO_LINE_START.includes(ch)) { // 行頭禁則：今の行にぶら下げる
        line += ch; width += w; used += w;
        lines.push(line); line = ''; width = 0;
        return;
      }
      lines.push(line); line = ''; width = 0;
    }
    line += ch; width += w; used += w;
    // 句読点で区切れて、行数が増えないなら、そこで改行する
    const rest = total - used;
    if (BREAK_AFTER.includes(ch) && width >= 4 && rest > 0 && rest <= limit * (n - lines.length - 1)) {
      lines.push(line); line = ''; width = 0;
    }
  });
  if (line) lines.push(line);
  return lines;
}

function buildSvg(rawTitle) {
  const title = normalizeTitle(rawTitle);
  const size = pickFontSize(title);
  const lines = wrap(title, size, W - PAD_X * 2);
  const lh = Math.round(size * 1.38);
  const blockH = lines.length * lh;
  const areaTop = 230;
  const areaBottom = 730;
  const firstBaseline = Math.round(areaTop + (areaBottom - areaTop - blockH) / 2 + size * 0.92);

  const label = esc(process.env.GBP_IMAGE_LABEL || '売却・相続コラム');
  const footer = esc(process.env.GBP_IMAGE_FOOTER || '株式会社クレアクロス');

  const tspans = lines.map((l, i) =>
    `<tspan x="${PAD_X}" y="${firstBaseline + i * lh}">${esc(l)}</tspan>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#12274a"/>
      <stop offset="1" stop-color="#1f5a9e"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <circle cx="1080" cy="-20" r="330" fill="#ffffff" fill-opacity="0.07"/>
  <circle cx="1180" cy="860" r="250" fill="#ffffff" fill-opacity="0.06"/>
  <rect x="${PAD_X}" y="96" width="${label.length * 38 + 64}" height="68" rx="34" fill="#ffffff" fill-opacity="0.16"/>
  <text x="${PAD_X + 32}" y="143" font-family="${FONT_FAMILY}" font-weight="700" font-size="34" fill="#ffffff">${label}</text>
  <rect x="${PAD_X}" y="${areaTop - 34}" width="88" height="8" rx="4" fill="#f4b942"/>
  <text font-family="${FONT_FAMILY}" font-weight="700" font-size="${size}" fill="#ffffff">${tspans}</text>
  <rect x="${PAD_X}" y="780" width="${W - PAD_X * 2}" height="2" fill="#ffffff" fill-opacity="0.35"/>
  <text x="${PAD_X}" y="840" font-family="${FONT_FAMILY}" font-weight="700" font-size="38" fill="#ffffff">${footer}</text>
</svg>`;
}

function renderCard(title, { width = W } = {}) {
  const resvg = new Resvg(buildSvg(title), {
    fitTo: { mode: 'width', value: width },
    font: { fontFiles: [FONT_FILE], loadSystemFonts: false, defaultFontFamily: FONT_FAMILY }
  });
  return resvg.render().asPng();
}

// ── 署名つきURL ──
const sign = (title, width) =>
  crypto.createHmac('sha256', secret()).update(`${width}|${normalizeTitle(title)}`).digest('hex').slice(0, 32);

function verifyImage(title, width, sig) {
  if (!imageEnabled() || !ALLOWED_WIDTHS.includes(width)) return false;
  const a = Buffer.from(sign(title, width));
  const b = Buffer.from(String(sig || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function buildImageUrl(baseUrl, title, width = W) {
  const t = normalizeTitle(title);
  return `${baseUrl}/gbp-image.png?t=${encodeURIComponent(t)}&w=${width}&sig=${sign(t, width)}`;
}

module.exports = { renderCard, verifyImage, buildImageUrl, imageEnabled, normalizeTitle, ALLOWED_WIDTHS };
