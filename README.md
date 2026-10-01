# FRONTIER

海外のフロンティア記事を日本語で読み、根拠のある知見を蓄積する個人用Webアプリ。
React / Vite / Hono / Cloudflare Workers / D1 / Workflows。mainが本番正本。今回の初期実装はドラフトPRで確認する。

## この実装で動くこと

- ホームの推薦1本、1カラムの本文、原文の段落参照、短い知見・問い・AIの見方案。
- 全文翻訳・無料部分の翻訳・日本語要約・原文リンクのみを区別した表示。
- 原資料、派生版、Claim / Concept / Question、本人の採用したViewを分離したD1保存。
- 日本語検索、読んだ位置の自動保存、明示採用、版の競合検出、JSON書き出し、削除後の再取り込み拒否。
- 利用可能な原資料から日本語化・Harvestを行うResponses adapterとWorkflows。通常の読書ではAIを呼ばない。
- 日次/月次予算の原子的な予約、実usageの精算、成否不明の送信は保守的に費用予約を維持。無条件の再送はしない。
- Cloudflare Accessの署名 / issuer / audience / exp / owner検証。HTML・静的アセット・API・検索・原文・書き出しを保護。
- 9媒体の候補台帳。全媒体は利用条件未確認または禁止のため初期無効。現在は自動本文取得を行わない。

保存・閲覧の入口は完成、日本語化ジョブはfixtureによる検証済み。**実媒体への自動接続、日次Cron、実APIの品質・原価測定、本番デプロイは未完了。**

## 起動

Node 24以上。

```sh
npm ci
npm run migrate
npm run dev
```

`http://localhost:8792/demo`で自作の架空記事を読める。APIキー不要。実在媒体の本文はfixtureにも公開リポジトリにも含めていない。
デモの既読と採用はブラウザ内だけに保存し、本人の実記録へは混ぜない。

実DBの経路へ同じ自作記事を入れる場合：

```sh
node --import tsx scripts/seed-demo.mjs
```

local認証省略は`ENVIRONMENT=local`かつloopbackホストに限定。preview / productionでは未認証を常に拒否する。

## UI

| 画面           | 主操作                  | 補助操作                     |
| -------------- | ----------------------- | ---------------------------- |
| ホーム         | 記事全体を開く1リンク   | フッターの記録・管理         |
| 本文           | 通常は読むだけ          | 原典、根拠、原文対応の詳細   |
| AI見方案の詳細 | 自分の見方にする1ボタン | 根拠、未採用/採用済みの表示  |
| 記録           | 自動検索する入力欄1つ   | 記事・採用した見方へのリンク |
| 管理           | 取り込み詳細内の1ボタン | 台帳、処理履歴、JSON書き出し |

常設の保存・翻訳・解析・分類・評価ボタン、サイドバー、追従ツールバーはない。
API障害時は再読み込みを残す。根拠リンクを押すと原文の詳細が開き、対象段落へ移動する。

## データと更新

`sources → captures → renderings → claims / concepts / questions / view_drafts`。
本人が採用した時だけ`view_revisions`を作る。同じ案の再送は二重採用しない。

原資料版と処理版のhashを安定IDとし、同一取り込みは再保存しない。修正時は`If-Match`に現在のrevisionを指定する。日本語化前の原資料を削除する場合は`If-Match: pending`を使う。
write guardのCHECK制約とD1 batchを使い、削除・版更新と競合した書き込みを原子的に拒否する。
旧版の失敗中も現在の完成版を読むことができる。

記事削除は全Capture/派生版/AI案/根拠本文を消し、墓標を残す。本人が採用した見方は文章を残し、根拠喪失と表示する。
ジョブから私的な出力を除去しても費用・usageを残すため、削除で予算がリセットされない。
WorkflowsのcheckpointにはID/フラグだけを保存し、原文・訳文を複製しない。

概念名と文脈上の意味が一致する場合のみ、過去の記録へのナビゲーションを作る。
これは支持・反証・因果の判定ではない。型付きRelationや既存Viewの改訂提案は次段階。

## インポートとAPI

管理のJSON取り込みは補助経路。原資料形式は`src/shared/model.ts`のbundleから`rendering`と`processingVersion`を除いた形。
日本語化済み記録には両項目を含める。自作の例は`src/shared/demo.ts`。

| API                               | 動作                                      |
| --------------------------------- | ----------------------------------------- |
| `GET /api/home`                   | 保存済みの推薦と少数の過去記録            |
| `GET /api/stories?q=...`          | 本文・知見・本人Viewの検索                |
| `GET /api/stories/:slug`          | 原文・日本語・知見・本人View              |
| `PUT /api/stories/:slug/progress` | 既読位置。古い時刻の更新は無視            |
| `POST /api/views/adopt`           | `draftId`, `revision`の明示採用           |
| `GET /api/export`                 | 出典・全版・知見・本人ViewのJSON          |
| `POST /api/admin/import`          | 日本語化済みrecord、変更時は`If-Match`    |
| `POST /api/admin/captures`        | 許可された原資料の保存                    |
| `POST /api/admin/jobs`            | `captureId`, `expectedRevision`で日本語化 |
| `DELETE /api/admin/stories/:slug` | `If-Match`で原資料とAI派生版を削除        |
| `GET /api/admin/status`           | 台帳とジョブの状態                        |

状態変更は同一OriginのJSONのみ。HTMLを挿入せずテキストとして描画し、原典URLはHTTPSに限定する。
API・HTMLに`private, no-store`とCSPを付け、私的な本文やSecretsを通常ログへ出さない。

## AIの設定・費用

OpenAI Docsの[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)に沿ったResponses APIを使う。
検索ツールは付けず、取得済みの原文範囲だけを送信する。原資料ごとの保存・外部AI送信・翻訳許可を確認する。

有効化には以下のすべてが必要。モデル名・料金は本番疎通と現在の公式料金で確認して設定する。

- `OPENAI_API_KEY`：`wrangler secret put OPENAI_API_KEY --env preview`等で設定。
- `OPENAI_MODEL`、`AI_ENABLED=true`。
- `DAILY_BUDGET_MICRO_USD`、`MONTHLY_BUDGET_MICRO_USD`。単位は100万分の1米ドル。
- `INPUT_MICRO_USD_PER_TOKEN`、`OUTPUT_MICRO_USD_PER_TOKEN`。モデル別単価を設定。未設定・0は実行拒否。

localでは`.dev.vars`にSecretsを入れる。`.dev.vars`はGit管理外。
最初はpreviewの小さな許諾済み原資料でAPI・翻訳品質・usageを確認してから有効化する。

入力は最大32KB、80段落、出力は最大6000トークン。上限超過は長文分割が必要として停止する。
構造・根拠ID・訳の段落順・数値の欠落を検証してから保存する。**否定・引用主体・意味の忠実性は自動検証だけでは保証しない。** 実記事の照合は#9で行う。
数値の日本語表記が変わる正しい翻訳も保守的に止まる場合がある。

呼び出し前に入力全payloadのUTF-8 bytesと最大出力から費用を多めに予約し、usageで精算する。
不明な送信・usage欠落は0円にせず予約を維持する。429の自動バックオフ、ownerの停止/再試行、長文分割は未実装。
通常のAPIキー課金はChatGPT購読と別。閲覧・再読込・位置保存・採用でAIを呼ばない。

## Cloudflareへ接続するための設定

preview / productionのDB・Workflow・Secretは別。`workers.dev`を無効にし、Access保護したcustom domainのみ使用する。

1. 環境ごとに`wrangler d1 create frontier-preview` / `frontier-production`を実行し、IDを`wrangler.jsonc`へ設定。
2. Accessのアプリでownerのメールだけ許可。team domain、AUD、OWNER_EMAIL、custom domain routeを各環境へ設定。
3. `wrangler d1 migrations apply DB --remote --env preview`を実行。
4. `npm run deploy -- preview`。本番も同じ手順でproductionを明示する。

deploy scriptはAccess設定・DB ID・保護したdomain routeがない状態でデプロイを拒否する。
本番Access設定や既存アカウントの認証情報は、この作業では提供されていない。

バックアップ・復元はownerが保護した環境で行う。**バックアップには私的原資料が含まれるため、Gitには入れない。**

```sh
npx wrangler d1 export DB --remote --env preview --output /secure/path/frontier-backup.sql
npx wrangler d1 execute DB --remote --env preview --file /secure/path/frontier-backup.sql
```

復元は空の同一スキーマDBへ。既存DBへの上書きは避ける。訂正/削除後は古いバックアップを破棄または再取得・再解析へ戻さない。
通常処理の停止は`AI_ENABLED=false`で新規呼び出しを止める。すでに送信した呼び出しの料金は発生し得る。

## 検証

```sh
npm run types
npm run build
npm test
npm run test:integration
npx playwright install chromium
npm run test:browser
```

- Unit：JWT・Origin、利用範囲、原文/訳/根拠整合、refusal/incomplete、数値、省略、予算。
- Workflow fixture：実SQLiteと注入したproviderで、日本語化→知見→保存・checkpoint再開・二重送信抑止・usage・削除を確認。**実API検証ではない。**
- Integration：実workerd / D1で保存・重複・検索・既読・本人採用・版競合・書き出し・削除・AI停止。previewの全画面/APIへの未認証アクセスを拒否。
- Browser：本番用Vite配布物と同じWorker / D1を用い、390pxと1280px、直接URL・再読込・原文参照・採用・検索・位置復元・横はみ出し・主操作数を確認。

QAは自作記事のみ。`artifacts/`へ画面証跡を出力する。`BROWSER_EXECUTABLE`で既存Chromiumを指定可能。
iPhone Safari実機、実媒体3本、実トリガー、実API原価・品質、本番URLは未確認。

## 次の実装

- #3：本人Viewの編集履歴、Markdown出力、バックアップ復元の実環境確認。
- #4：429の有限バックオフ、安全なowner再開/停止、実API疎通。
- #7：確認済みソースの公式配信接続、安全なHTTP取得、選定・重複排除。
- #14：長文分割、支持/反証/条件限定のRelation、本人View改訂案。
- #8：JST日次Cron→取得→日本語化→知見保存→Edition。
- #9：2媒体・3実記事、API・運用・Safariの最終E2E。

今回のPRだけでP0全件を完了扱いにしない。
