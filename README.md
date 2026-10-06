# line-bot-realestate

不動産初期対応 LINE Bot（Render.com / Node.js）

## Google ビジネスプロフィール 週2回投稿（LINE承認制）

マイベストプロの売却・相続コラムを、Google用の短文にして週2回（火・金 朝9時）投稿します。
**投稿前に必ずスタッフが LINE で承認**します。

```
GitHub Actions（火・金9時）→ ボット → Claudeが要約 → LINEに投稿案＋ボタン
        → 「承認して投稿」→ Google ビジネスプロフィールに投稿
```

### 毎回の運用
1. スプレッドシート **「GBP投稿」タブ**（初回起動時に自動作成）に、記事を1行ずつ追加
   - B：タイトル / C：元文章（マイベストプロの本文を貼り付け）/ D：参考URL（ボタンの遷移先。空ならトップページ）
   - E（状態）は空欄のままでOK。自動で「承認待ち → 投稿済」に変わります
2. 火・金の朝にLINEへ投稿案が届く → **承認して投稿 / 作り直す / スキップ**
3. ネタが残り2本以下になるとLINEで通知されます
4. 今すぐ案を作りたいときは、管理者のLINEから `#gbp案` と送信

### セットアップ
**① Google Business Profile API の利用申請（最初に。承認まで日数がかかります）**
Google Cloud でプロジェクトを作り、「Business Profile API」の利用申請フォームを提出します。
承認前でも、手順②〜④だけで「テスト動作」（承認ボタンまで確認、Googleには投稿しない）ができます。

**② Render の環境変数**

| 名前 | 内容 |
|---|---|
| `ANTHROPIC_API_KEY` | 要約用の Claude API キー |
| `CRON_SECRET` | 長いランダム文字列（下の GitHub Secrets と同じ値） |
| `GBP_CLIENT_ID` / `GBP_CLIENT_SECRET` | Google の OAuth クライアント |
| `GBP_REFRESH_TOKEN` | `node scripts/gbp-refresh-token.js` で取得 |
| `GBP_ACCOUNT_ID` / `GBP_LOCATION_ID` | 投稿先の数字ID（API の accounts / locations 一覧で確認） |
| `GBP_DEFAULT_URL` | 任意。既定は `https://creacross.jp/` |
| `GBP_CLAUDE_MODEL` | 任意。要約に使うモデル |

`GBP_*` が未設定の間は、承認しても実際には投稿されません。

**③ GitHub の Secrets（Settings → Secrets and variables → Actions）**
`BOT_URL`（例：`https://xxxx.onrender.com`）と `CRON_SECRET`

**④ 動作確認**
GitHub の Actions タブで「GBP投稿案の作成」を手動実行 → LINEに案が届けばOK

### 安全のための仕組み
- 承認なしでは投稿されません（承認できるのは `ADMIN_USER_IDS` のスタッフのみ）
- 投稿文を自動チェック（URL・電話番号・「絶対」「最安」「日本一」などの誇大表現・1,500文字超）。問題があるときはLINEに警告を表示
- 元文章にない事実や数字を足さないよう Claude に指示。法律・税務は一般論にとどめ、専門家確認を促す文面にしています
- 二重投稿防止：ボタン連打は無視、投稿失敗時は自動再試行せず「エラー」で停止
