# FRONTIER

海外のフロンティア記事を日本語で読み、根拠のある知見を蓄積する個人用Webアプリ。
React / Vite / Hono / Cloudflare Workers / D1 / R2 / Workflows。mainが本番正本。今回の初期実装はドラフトPRで確認する。

## この実装で動くこと

- ホームの推薦1本、1カラムの本文、原文の段落参照、短い知見・問い・AIの見方案。
- 全文翻訳・無料部分の翻訳・日本語要約・原文リンクのみを区別した表示。
- 原資料、派生版、Claim / Concept / Question、本人の採用したViewを分離したD1保存。根拠付きRelation・既存Viewの改訂案も別に保持する。
- 日本語検索、読んだ位置の自動保存、明示採用、版の競合検出、JSON / Markdown書き出し、本人のメモと編集履歴、削除後の再取り込み拒否。非表示は再取得・再解析でも維持する。
- 利用可能な原資料から日本語化・Harvestを行うResponses adapterとWorkflows。通常の読書ではAIを呼ばない。
- 日次/月次予算の原子的な予約、実usageの精算、成否不明の送信は保守的に費用予約を維持。無条件の再送はしない。
- Cloudflare Accessの署名 / issuer / audience / exp / owner検証。HTML・静的アセット・API・検索・原文・書き出しを保護。
- 保存済み日本語版のブラウザ読み上げ。端末内の日本語音声のみを使い、速度・段落移動・一時停止・版ごとの位置保存に対応。
- 9媒体の候補台帳。全媒体は利用条件未確認または禁止のため初期無効。RSS / Atomで記事を発見し、設定済みの公開HTML本文・配信字幕を取り込める。URLから画像・音声・動画・PDFも共通の原資料へ変換する。

保存・日本語化・横断接続・日次Editionまでfixtureで検証済み。**実媒体の許諾と公式フィード設定、実APIの品質・原価、実Cron・Access・本番デプロイは未確認。** 未設定の媒体や課金処理を自動で有効化しない。

2026-10-02にTechCrunchの実RSSでDNSチェック・解析・隔離DB保存を確認し、公開IPv4の誤拒否を修正。TechCrunchのRSSは89〜268文字の抜粋だったが、Not Boringの実RSSは20件中17件に本文上限内のテキストを含み、公開記事HAAから55段落・17,363文字を抽出できた。実APIで日本語化まで確認した段階ではない。通信transportや本番設定の制約は[確認範囲](docs/verification.md)を参照。

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

| 画面           | 主操作                  | 補助操作                         |
| -------------- | ----------------------- | -------------------------------- |
| ホーム         | 記事全体を開く1リンク   | フッターの記録・管理             |
| 本文           | 通常は読むだけ          | 聴く、原典、根拠、原文対応の詳細 |
| AI見方案の詳細 | 自分の見方にする1ボタン | 根拠、未採用/採用済みの表示      |
| 記録           | 自動検索する入力欄1つ   | 記事・採用した見方へのリンク     |
| 管理           | 取り込み詳細内の1ボタン | 台帳、処理履歴、JSON書き出し     |

常設の保存・翻訳・解析・分類・評価ボタン、サイドバー、追従ツールバーはない。
API障害時は再読み込みを残す。根拠リンクを押すと原文の詳細が開き、対象段落へ移動する。

## 保存済み記事を聴く

端末に日本語音声があるときだけ、記事冒頭の「聴く」から開始する。基本操作は再生/一時停止と詳細。詳細に速度、音声、段落移動、終了をまとめ、Escでも終了して元の操作へフォーカスを戻す。

原著者・媒体・取得範囲・機械翻訳の説明、日本語本文、AI抽出と重要な留保を順に読む。新しい文章や音声ファイルを生成しない。原文URLを長々と読み上げない。端末外の音声サービスは選ばない。

位置はimmutableな日本語revisionごとに自動保存する。再読込・中断後は短い文の先頭から再開し、新しい版に古い音声位置を適用しない。記事削除時は音声位置も消去する。デモだけはブラウザ内に保存する。

画面消灯・別アプリへの移動時は停止する。自動再開やバックグラウンド再生は行わない。日本語音声がない場合は短い説明を出し、本文は読める。ブラウザテストは音声APIを制御した操作検証で、iPhone Safari実機、実音声の品質・割込み挙動は未確認。

参照：[SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis) / [SpeechSynthesisUtterance](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance)

## データと更新

`sources → captures → renderings → claims / concepts / questions / view_drafts`。
本人が採用・編集・メモ保存した時だけ`view_revisions`を作る。同じ案の再送は二重採用しない。`view_heads`は現在版を指し、文章を上書きせず履歴を追加する。AIの既存View改訂案は`view_proposals`に保存し、明示採用と本人版の競合確認が済むまで現在版を変更しない。

原資料版と処理版のhashを安定IDとし、同一取り込みは再保存しない。修正時は`If-Match`に現在のrevisionを指定する。日本語化前の原資料を削除する場合は`If-Match: pending`を使う。
write guardのCHECK制約とD1 batchを使い、削除・版更新と競合した書き込みを原子的に拒否する。
旧版の失敗中も現在の完成版を読むことができる。

記事削除は全Capture/派生版/AI案/根拠本文を消し、墓標を残す。本人が採用した見方は文章を残し、根拠喪失と表示する。
ジョブから私的な出力を除去しても費用・usageを残すため、削除で予算がリセットされない。
WorkflowsのcheckpointにはID/フラグだけを保存し、原文・訳文を複製しない。

概念名と文脈上の意味が一致する場合のみ、過去の記録へのナビゲーションを作る。
型付きRelationは最大3件。支持・異なる結果・条件限定・類似をAIの解釈として保持し、両側のClaimと原文段落、条件を検証する。単なる共起を因果とは扱わない。原資料の独立性は未確認として扱い、転載や同じ発表を独立した裏付けに数えない。旧日本語版は`?revision=...`で当時のCaptureに戻れる。Editionも推薦時の版へ固定する。

## インポートとAPI

管理のJSON取り込みは補助経路。原資料形式は`src/shared/model.ts`のbundleから`rendering`と`processingVersion`を除いた形。
日本語化済み記録には両項目を含める。自作の例は`src/shared/demo.ts`。

| API                                       | 動作                                                             |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `GET /api/home`                           | 保存済みの推薦と少数の過去記録                                   |
| `GET /api/stories?q=...`                  | 本文・知見・本人Viewの検索                                       |
| `GET /api/stories/:slug`                  | 原文・日本語・知見・本人View                                     |
| `GET/PUT /api/stories/:slug/listening`    | 日本語revisionごとの音声位置。別記事参照・範囲外・古い時刻を拒否 |
| `PUT /api/stories/:slug/progress`         | 既読位置。古い時刻の更新は無視                                   |
| `POST /api/views/adopt`                   | `draftId`, `revision`の明示採用                                  |
| `GET /api/export`                         | 出典・全版・知見・本人ViewのJSON                                 |
| `GET /api/export?format=markdown`         | 最新100記事と出典・知見・本人履歴のMarkdown                      |
| `GET /api/views/:root/history`            | 本人の文章の履歴                                                 |
| `PUT /api/views/:root`                    | `expectedRevision`, `text`で本人版を追加                         |
| `POST /api/stories/:slug/notes`           | `revision`, `text`で本人のメモを保存                             |
| `POST /api/views/proposals/:id/adopt`     | 既存ViewのAI改訂案を明示採用                                     |
| `POST /api/admin/import`                  | 日本語化済みrecord、変更時は`If-Match`                           |
| `POST /api/admin/captures`                | 許可された原資料の保存                                           |
| `POST /api/admin/jobs`                    | `captureId`, `expectedRevision`で日本語化                        |
| `DELETE /api/admin/stories/:slug`         | `If-Match`で原資料とAI派生版を削除                               |
| `GET /api/admin/status`                   | 台帳、日次段階・件数・費用・ジョブ                               |
| `PUT /api/admin/sources/:id`              | 許可確認済みのフィードと条件を設定                               |
| `POST /api/admin/sources/:id/ingest`      | 設定済みフィードを取得                                           |
| `POST /api/admin/daily`                   | JST当日の処理開始。`resume:true`で再開                           |
| `POST /api/admin/jobs/:id/stop`           | 新しい送信・保存を止める                                         |
| `POST /api/admin/jobs/:id/retry`          | 既存結果・分割receiptを再利用した安全な再開                      |
| `PUT /api/admin/stories/:slug/visibility` | `revision`, `hidden`で表示状態を変更                             |

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

入力は最大32KB、80段落。短文は翻訳・Harvest・接続を1回で生成する。長い全文/部分訳は段落対応を保って最大4分割し、別のHarvestと合わせて最大5回、各6000出力トークンまで。各分割のreceipt・使用量をD1へ保存し、原文の文字列・段落順・分割IDを照合して再結合する。32KBや4分割を超える資料は開始前に拒否する。
構造・根拠ID・訳の段落順・数値の欠落を検証してから保存する。明らかな否定・引用主体の脱落は照合待ちとして止める。**否定・引用主体・意味の忠実性は自動検証だけでは保証しない。** 実記事の照合は#9で行う。
数値の日本語表記が変わる正しい翻訳も保守的に止まる場合がある。

呼び出し前に入力全payloadのUTF-8 bytesと最大出力から費用を多めに予約し、usageで精算する。
不明な送信・usage欠落は0円にせず予約を維持する。429はRetry-Afterを上限60秒で尊重し、各呼び出し最大3回。同時に予約・送信するジョブは最大2つ。不明な送信は自動再送しない。owner停止後は送信/保存のCASで遅着結果を拒否する。既知の拒否や保存済みreceiptだけ安全に再開でき、分割途中の再開は同じJST日付に限る。日付を跨いだ費用不明の操作は未確認として停止する。
通常のAPIキー課金はChatGPT購読と別。閲覧・再読込・位置保存・採用でAIを呼ばない。

## フィードと日次実行

取得は登録済み媒体の確認済みHTTPSホストのみ。取得前の公開DNS確認、各redirectの再確認、最大3redirect、20秒・2MB、XML深度64、HTMLのテキスト化、60分以上の頻度制御を行う。媒体ごとに本文範囲のselectorを設定した場合は、記事URLの公開HTMLも取得する。画像等のホストも明示的に許可する。ログイン・非XML応答・取得拒否は停止する。原文が短すぎる候補や更新のないフィードは正常skip、取得障害はfailed、費用上限はbudget_stoppedとして残す。

管理の媒体設定例（URLと権利は例示であり、有効化の根拠にはならない）：

```json
{
  "enabled": false,
  "feedUrl": "https://example.com/official-feed.xml",
  "reason": "公式URLと4つの許可を確認してから有効化する",
  "policy": {
    "acquire": false,
    "store": false,
    "ai": false,
    "translate": false,
    "basis": ["https://example.com/licensing"],
    "checkedAt": "2026-10-01T00:00:00Z",
    "validUntil": "2026-10-31T00:00:00Z",
    "allowedHosts": ["example.com"],
    "scope": "feed_excerpt",
    "contentField": "description",
    "mode": "partial_translation",
    "frequencyMinutes": 1440,
    "article": { "selector": "article" },
    "media": ["image", "audio", "video", "captions", "pdf"]
  }
}
```

許可レビューの有効期間は最大90日。全文訳は`feed_full`と許可された全文フィールドが必要。RSSならdescription/content:encoded、Atomならsummary/contentから指定された1フィールドのみ読む。公開/更新/取得日時、フィードID、canonical URL、原文hash、選定理由を記録する。同じ原文の転載と追跡パラメータは重複扱い。別記事が同じイベントを扱うかは自動で断定せず、関係の独立性も未確認とする。

`DAILY_ENABLED=true`・AI設定・許可が揃った場合だけ、Cron→DailyWorkflow→取り込み→最大2本のHarvestWorkflow→1本のEditionへ進む。本番CronはUTC 23:00（JST翌朝8:00）、previewはCronなし。コードの初期値はDAILY_ENABLED=false / AI_ENABLED=false。

JST当日の候補登録は全媒体合計最大10件。日次では媒体ごと最大2件を取り込み、直近14日から上限10候補を見て原文重複と媒体偏りを抑える。機構・導入・数値に関する明示的な語句を選定の補助に使うが、内容の真偽の評価とは扱わない。弱い日は推薦を作らず、前回の保存済み記録を読む。完成した推薦外の記事も記録へ残す。

同日の実行ID・選定結果・子ジョブIDを再利用する。再開で新しい翻訳枠を追加しない。子ジョブ失敗は管理詳細で安全に再試行してから日次処理を再開する。成否不明の送信は手動再開でも再送しない。Workflowsが10分以内に完了しない場合はawaitingを残し、後から既存子ジョブを確認してEditionだけ確定できる。

## 本文・画像・音声・動画の共通取り込み

管理画面の「原資料のURL」から読み取る。媒体設定は`article.selector`（article / main / #id / .class）と`media`で取り込み範囲を指定する。指定した本文範囲に見つかる公開字幕・直接の画像/音声/動画も対象とする。ログインが必要な本文、隠れた有料本文、埋め込みiframeやYouTube等の専用取得は実装していない。

| 原資料              | 共通段落への変換                          | 保持する根拠           |
| ------------------- | ----------------------------------------- | ---------------------- |
| 公開HTML / テキスト | 本文のテキスト                            | 公開URL・段落ID        |
| VTT / SRT字幕       | 配信字幕のテキスト                        | 原資料URL・開始/終了秒 |
| PNG / JPEG / PDF    | OCRと図のAI説明を分離                     | 原資料URL・PDFページ   |
| 音声                | 16kHz mono PCMに変換して文字起こし        | 原資料URL・開始/終了秒 |
| 音声付き動画        | 文字起こし＋4枚の代表フレームのOCR/AI説明 | 原資料URL・秒位置      |

変換した段落は既存の日本語化・Claim / Concept / Question・関係・本人の明示採用へ渡す。OCR/文字起こしは誤読の可能性を表示し、映像のAI説明だけから作るClaimはAI推論として保持する。全動画の場面を見たとは扱わない。公開日を取得できなければ「取得（公開日不明）」を表示する。

直接の音声/動画は3分・12MBまで、PDFは2MBまで。画像はブラウザで長辺1024pxのJPEGへ変換する。コーデックはブラウザがdecode可能なものに限る。長い動画は配信字幕から取り込む。元の圧縮ファイルは保持せず、処理に渡した画像/PCM/代表フレーム/PDFをprivate R2へ保存する。通常の読書・原資料参照で追加AI呼び出しはしない。

画像/PDF/音声の読み取りにはAI設定に加え、`VISION_INPUT_TOKEN_BOUND`（画像またはPDFごとの保守的な入力token予約上限、50,000〜2,000,000）と`AUDIO_MICRO_USD_PER_SECOND`（whisper-1の秒単価）を検証して設定する。既定は0で停止する。visionはOPENAI_MODELに画像・PDFとStructured Outputsを扱えるモデルが必要。公式仕様：[画像入力](https://developers.openai.com/api/docs/guides/images-vision)、[PDF入力](https://developers.openai.com/api/docs/guides/file-inputs)、[文字起こし](https://developers.openai.com/api/docs/guides/speech-to-text)。visionのusageと音声のPCM実長から費用を記録し、日本語化は別ジョブで予約する。

RSS発見と公開HTML/配信字幕取得は日次処理にも接続済み。直接の音声・動画・画像・PDFの前処理は所有者のブラウザで行うため、この経路のCron自動実行は未対応。本文は80段落・Capture 32KBまでで、超過した原文は切り捨てず分割待ちとして残す。

## Cloudflareへ接続するための設定

preview / productionのDB・Workflow・Secretは別。`workers.dev`を無効にし、Access保護したcustom domainのみ使用する。

1. 環境ごとに`wrangler d1 create frontier-preview` / `frontier-production`を実行し、IDを`wrangler.jsonc`へ設定。
2. 環境ごとに`wrangler r2 bucket create frontier-media-preview` / `frontier-media-production`を実行。R2をpublicにしない。
3. Accessのアプリでownerのメールだけ許可。team domain、AUD、OWNER_EMAIL、custom domain routeを各環境へ設定。
4. `wrangler d1 migrations apply DB --remote --env preview`を実行。
5. `npm run deploy -- preview`。本番も同じ手順でproductionを明示する。

deploy scriptはAccess設定・DB ID・保護したdomain routeがない状態でデプロイを拒否する。
本番Access設定や既存アカウントの認証情報は、この作業では提供されていない。

バックアップ・復元はownerが保護した環境で行う。**バックアップには私的原資料が含まれるため、Gitには入れない。**

```sh
npx wrangler d1 export DB --remote --env preview --output /secure/path/frontier-backup.sql
npx wrangler d1 execute DB --remote --env preview --file /secure/path/frontier-backup.sql
```

D1/JSON/Markdown書き出しにはR2のバイナリが含まれない。原資料も復元する場合はR2の対応objectを別途バックアップし、同じキーで戻す。削除時はDBの原文/receiptを消去してR2も削除する。R2削除が通信失敗した場合は非公開のobjectが残り得るため、削除済みsourceの残存キーを再清掃する必要がある。

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
npm run test:media-browser # ffmpegが必要
```

- Unit：JWT・Origin、利用範囲、原文/訳/根拠整合、refusal/incomplete、数値、省略、予算。
- Workflow fixture：実SQLiteと注入したproviderで、日本語化→知見→保存・checkpoint再開・二重送信抑止・usage・削除を確認。**実API検証ではない。**
- Integration：実workerd / D1で保存・重複・検索・既読・本人採用・版競合・書き出し・削除・AI停止。previewの全画面/APIへの未認証アクセスを拒否。
- Browser：本番用Vite配布物と同じWorker / D1を用い、390pxと1280px、直接URL・再読込・原文参照・採用・検索・位置復元・横はみ出し・主操作数を確認。

QAは自作記事のみ。`artifacts/`へ画面証跡を出力する。`BROWSER_EXECUTABLE`で既存Chromiumを指定可能。
iPhone Safari実機、実媒体3本、実トリガー、実API原価・品質、本番URLは未確認。

## 未確認の実環境項目

- 2媒体以上の許諾、公式フィードURLと利用範囲。全候補媒体は初期無効。Contraryの自動取得は禁止状態を維持する。
- 許諾済みの3実記事による忠実性・関係の妥当性、実Responses APIのusageと単価、実Cronの発火。
- Cloudflare Accessのowner/別ユーザー、preview/productionの鍵・DB分離、本番URL、iPhone Safari実機。
- 本番D1のバックアップ復元。localの実D1 export→空DBへのrestoreは統合検証済み。

P0のコードを実装したことと、実媒体・実API・本番で受入済みであることは区別する。実環境設定がない項目を完了扱いにはしない。P1の追加調査・独自特集は通常の読書・日次処理には混ぜない。
