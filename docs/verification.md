# 実装と確認範囲

30件のunit / workflow fixture、実workerd / D1統合、本番用ViteビルドのChromium操作を確認。実媒体本文と本人の私的記録はfixtureや公開リポジトリへ入れていない。2026-10-02にTechCrunchの実RSSを隔離DBで技術検証した範囲と制約は下記のとおり。

| Issue           | 実装と確認した動作                                                                                                               | 実環境で未確認                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| #3 保存         | 原文/日本語/AI/本人の分離、CAS更新、本人のメモと履歴、当時のCapture参照、削除と非表示、JSON/Markdown、D1 SQL export→空DB restore | 本番D1の復元・実Access/別ユーザー                             |
| #4 ジョブ       | 設定/権利/費用予約、2同時ジョブ、429最大3回、曖昧な送信を再送しない、停止時と削除後の遅着拒否、部分receipt再利用                 | 実モデル対応・usage/単価・Cloudflare基盤費用                  |
| #7 取り込み     | 許可4項目、review期限、公式ホスト制限、公開DNS/redirect/サイズ/時間/深度、RSS/Atom指定範囲、原文重複と更新、頻度・JST合計10候補  | 2媒体の許諾・公式フィード・実配信からの取得                   |
| #14 日本語/知見 | 最大4翻訳分割とHarvest、段落ID/順/原文再結合、数値/否定/引用主体の検出、両側根拠の関係、文脈別概念、本人ViewのAI改訂案と明示採用 | 3実記事の忠実性、分割境界の自然さ、関係の意味と原資料の独立性 |
| #8 日次         | JSTの実行ID、2翻訳/1推薦、重複実行と再開で再翻訳しない、AI-off skip、日付固定のEdition、未完了/失敗/予算停止の区別               | 本番Cron発火、公開媒体から推薦までの通し運用                  |
| #9 画面         | 390/1280px、根拠リンク・旧版、メモ、本人編集、関係、改訂案採用、管理設定、主操作数、横はみ出し、読書で生成しない                 | iPhone Safari実機・本番URL・実記事による確認                  |

SourceRegistryの9媒体は初期無効。AI_ENABLED / DAILY_ENABLEDもfalse、SecretsとAccess / DB IDは未提供。実稼働や課金呼び出しは行っていない。

## 2026-10-02 実RSSとデプロイの確認

- TechCrunch公式RSS `https://techcrunch.com/feed/`：HTTP 200、17,046 bytes。SHA-256 `d3c730b93022555cdcaff7af69889a08167aaf4ecbf3f90853b7457fe280082b`。確認開始は00:32:21 UTC。
- 実DNS A/AAAAと実RSSをcurlのHTTPS transport経由でアプリの `fetchFeed` / `ingestFeed` に渡した。7 migrationsを適用した隔離SQLiteのD1互換DBへ10件保存、20件解析。取得直後の再実行はfrequency_limit、翌JST日の同一response replayは追加0件。DNS応答はfixtureではない。リンク先本文とAI APIは取得・呼び出ししていない。
- 配信されたdescriptionは89〜268文字。保存した10件はすべて `insufficient_public_text`、翻訳可能候補0件。短いRSS抜粋だけでは本来の日本語記事・日次推薦を検証できない。
- [RSS利用条件](https://techcrunch.com/rss-terms-of-use/)には改変制限があるため、翻訳許可とは判断していない。隔離検証はai=false / translate=false。本番台帳の許可・有効状態は変更していない。
- 実DNS確認で公開IPv4 `192.0.66.220` を拒否する不具合を再現して修正。[IANAの特殊用途IPv4範囲](https://www.iana.org/assignments/iana-ipv4-special-registry)に合わせ、192.0.0/24・192.0.2/24・198.51.100/24・203.0.113/24の拒否を維持し、その周囲の公開アドレスを誤って/16単位で拒否しない。拒否範囲と境界をunitで確認した。
- Nodeの直接fetchによるDNS照会はこのworkspaceでtimeout。上記の実通信成功はcurl transportであり、デプロイしたCloudflare Workerのfetch/D1/Workflows疎通は未確認。
- deploy scriptはJSONCの末尾カンマでSyntaxErrorになっていたため、JSONC parserとエラー検査へ修正。未設定時のAccess / D1 / route / workers.dev無効の各拒否をunitで確認。現在のproduction実行はAccess設定不足として停止する。
- **未デプロイ**。Wranglerは未認証。Cloudflare管理画面は1回の再読み込み後もセキュリティ検証で停止。Access issuer/audience/owner、production D1 ID、保護したdomain routeが未設定。実モデル・原価・実記事の翻訳品質、本番Cronも未確認。

数値・否定・引用主体の検査は保守的な欠落検出で、意味の正しさを証明するものではない。RelationはAIの解釈、原資料の独立性は未確認として表示する。改訂案を生成しても本人の現在版は変えない。

RSS/Atom発見と原資料取得を分離。明示設定した公開HTML本文・配信字幕とURLからの画像/音声/音声付き動画/PDFを共通Captureへ変換する。ログインや隠れた有料部分は取得しない。同じ原文の転載は重複扱い。同じイベントを扱う別記事の統一判定や独立性の確認には実資料での照合が必要。

エラーとチェックポイントには安全なコード・ID・段階だけを残す。元データとAI receiptはD1に分離保存し、削除時に本文を除去して費用だけを保持する。

#10のコードも実装：端末内日本語音声、初期1操作・再生/詳細、速度・段落移動・終了/Esc、版ごとのD1位置保存、旧時刻/他記事/範囲外/削除の拒否。ブラウザの制御fixtureで自動再生なし、中断、再読込復元、遅着イベント無視、完了、音声なしを確認。実音声・iPhone Safari・消灯/アプリ切替/割込みの実機挙動は未確認。

## 2026-10-02 本文・媒体の取り込み拡張

- RSS上限を2MBへ変更。1MB超の自作フィード、公開HTMLの指定本文範囲、字幕の開始/終了秒、取得後の媒体設定変更による停止を確認。過長記事も発見メタデータを残し、切り捨てた本文を全文と扱わない。
- Not Boringの実RSS `https://www.notboring.co/feed` はcurlでHTTP 200、1,466,652 bytes。SHA-256 `48309d23553a55e22eb3423c89809e9cbebee2de2bf7942a788a8b0d721db778`。20件解析、17件が既存の80段落/24KB text上限内、3件は分割待ち。この保存済み実responseをfetchFeed/ingestFeedに渡して隔離DBへ10件保存。今回のDNS応答は注入fixtureであり、Cloudflareの実fetchを確認したものではない。ai=false / translate=falseのため処理候補は許可待ち。公開範囲に有料記事のプレビューも含まれ、全件の完全な本文とは判断していない。
- 実公開HTML `https://www.notboring.co/p/haa` はcurlでHTTP 200、215,652 bytes。SHA-256 `a05e8ee71bc5e6841fa2058607ea91824cedf5df4faf5642b1362ee3c6616e58`。`.available-content`を本文範囲にして55段落・17,363文字、Capture 24,567 bytesを生成できた。本番台帳は無効のまま、AI呼び出し0回。著作本文はGitのfixtureや資料に保存していない。
- 新しいmedia Workflowのprovider fixtureで、画像OCR/映像説明と音声文字起こしを共通段落へ変換し、原資料URL/秒位置を保持。再開でpaid receiptを再送しない。曖昧timeoutは1送信で費用予約維持、429は最大3回、予算不足は0送信、削除後の遅着receiptは保存されない。削除はR2資料とDB内容を消去し、確定費用・未知の費用予約を保持する。
- ブラウザ変換テストはffmpegの自作2秒WebMを用い、実decode → mono 16kHz PCMと4JPEGの時間位置を検査する。ローカルではChromium配布zipが不完全でinstall失敗したため、今回のブラウザ確認はCI結果を参照する。iPhone Safari、公開実動画のコーデック、実APIのOCR/文字起こし/日本語化の品質は未確認。
- 直接の音声/動画の上限は3分・12MB。PDFは2MB。映像は4代表フレームで、全場面の観察ではない。動画前処理はブラウザ実行のため、直接動画のCron取り込みは未対応。配信字幕付き公開HTMLは日次取得に接続。
- デプロイにはprivate R2とMediaWorkflowも追加で必要。R2原資料はD1/JSON/Markdown exportに含まれず、別途objectのバックアップが必要。実API/Cloudflare設定と認証の不足により、本番デプロイは引き続き未完了。
