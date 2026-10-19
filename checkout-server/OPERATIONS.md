# BODY-MAKE CHIPS 決済・在庫運用

## 現在の状態

2026-10-20時点でSandbox専用Cloudflare Workerへデプロイ済み。実際のStripe SandboxとTurnstileを通した3セットの決済・Webhook・在庫連動が成功。本番LPは販売準備中のまま。公開中の価格・発送予定・返品条件は更新済み。本番Workerは販売停止状態で設置済み。本番の3商品・価格はDashboardで登録済み。Stripe本番キー・Webhookの設定と本番API経由の照合は未完了。

Sandbox: `body-make-chips-checkout-sandbox`。ローカルの実接続テストは `http://127.0.0.1:4175`。設定ファイルの `SALE_ENABLED=true` は **Sandboxだけ**に適用される。秘密値3種類はCloudflare Secretsへ保存済み。デプロイした版は `5589f56d-1e89-41d9-9c19-6905a1b2650c`。

本番: `body-make-chips-checkout`。専用の `wrangler.live.toml` を使用する。Turnstileは `body-make-chips.jp` 限定の別ウィジェットを作成し、Secretを本番Workerだけに保存済み。現在の `/availability` は `sales_closed` を返す。本番在庫の500袋は設定値として用意されているが、Stripeキー接続後のDB初期化・実測確認は未実施。

Stripe本番のセキュリティ申告は、本人の確認・送信承認を得て提出済みで、Stripeの完了表示を確認。本人確認書類の提出依頼が別途残っている。本番接続の承認・決済機能の確認を終えるまでLPの購入受付を有効にしない。

既存の独立したSandbox Payment Linksは今回のLPでは使わない。一部旧価格のため共有・本番転用しない。

## 販売条件

| セット | 袋数 | 税・送料込み |
| --- | ---: | ---: |
| お試し | 3 | 1,280円 |
| 10袋 | 10 | 3,980円 |
| 30袋 | 30 | 10,500円 |

共通在庫500袋。日本国内のみ。2026-11-05から順次発送。それ以降の通常注文は入金確認後3営業日以内に発送。購入者都合の返品不可。不良品・誤配送は到着後7日以内の連絡で交換または返金。

本番商品は `prod_VTJj9lFMWXu8vv`（3袋）、`prod_VTJka6pd0nN8Rj`（10袋）、`prod_VTJknEy3oyP8SS`（30袋）。価格は `wrangler.live.toml` に設定済み。検索キーは順に `bmc_trial_3_20261020`、`bmc_desk_10_20261020`、`bmc_stock_30_20261020`。すべてJPY・1回限りで登録している。

## 接続・公開の順序

1. Stripe本番アカウントの決済停止・未提出項目を解消する。実際の運用者の本人確認、銀行口座、セキュリティ申告は事実に沿って登録する。
2. Cloudflareアカウントを接続。Sandbox専用Workerを作成し、Turnstileウィジェットにテストサイトのホスト名を登録する。
3. Stripe Sandbox用の制限付きキーを作成する。必要範囲はPricesの読み取り、Checkout Sessionsの読み書き。Dashboardの権限依存も実機で検証する。キーはCloudflare Secretsに保存し、HTML・Git・共有ログには入れない。
4. `STRIPE_RESTRICTED_KEY`、`STRIPE_WEBHOOK_SECRET`、`TURNSTILE_SECRET_KEY`をSecretsに登録。`SITE_ORIGIN`、3つの`PRICE_*`、`STRIPE_MODE`を対応する環境に設定する。
5. Stripeの公開情報に販売条件URL `https://body-make-chips.jp/legal.html` とプライバシーURL `https://body-make-chips.jp/privacy.html` を設定する。領収書・販売者への決済通知、サポート連絡先、明細表記、決済手段も確認する。
6. Webhookの送信先をWorkerの`/webhook`に設定。対象は `checkout.session.completed`、`checkout.session.expired`、`checkout.session.async_payment_succeeded`、`checkout.session.async_payment_failed`。
7. Sandboxで3セットの成功、カード失敗、中断、期限切れ、通信失敗、Webhook再配信、スマホ購入を検証。Stripeの金額と在庫記録、配送先・氏名・電話番号・メールを照合する。
8. 本番は**別Worker名・別Durable Object名前空間**を使う。テスト在庫を本番へ転用しない。3つの本番Price IDと本番用Secretsを使用する。
9. 本番接続・Webhook・500袋の初期値を確認後、サーバーの`SALE_ENABLED=true`、LPの`saleStatus=live`と`checkout.apiOrigin`、`checkout.turnstileSiteKey`を設定。`node build.mjs`でLPと法定表記を生成する。
10. 必要なファイルだけをコミット・公開し、公開URLで再検証。実課金のテストは金額と実行を別途確認する。

本番の独立したPayment Linkは共通在庫を通らない。購入導線にはこのAPIから発行するCheckoutのみを使う。

本番Workerのデプロイは `node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.live.toml`。本番Secretの登録にも必ず `--config wrangler.live.toml` を付ける。設定ファイルを省略したコマンドはSandboxへ向かう。本番Price IDが空欄のまま販売を有効にしない。

## 毎日の発送

Stripe本番Dashboardで支払いが成功した注文を確認し、袋数・送付先・入金を照合して発送する。非同期決済の支払い待ちは発送しない。注文IDを発送管理に記録し、二重発送を防ぐ。発送連絡・追跡番号の通知は手動で行う想定で、メールの自動発送通知は未実装。

決済直後のブラウザー画面だけを発送根拠にしない。Webhookと5分ごとの照合処理で在庫が確定する。受注記録はStripe、在庫DBは注文識別子・袋数・金額・状態のみを保持し、カードや配送先住所を保持しない。

## 在庫と例外

- 購入手続き開始時に35分間確保する。同一注文の再試行は同じ在庫確保とStripe冪等キーを使う。
- 期限切れ・非同期決済失敗は、Stripeの状態を確認して在庫を戻す。通信が不明な場合は確保を維持し、定期照合する。
- 決済成功分は消費済みとして保持する。返金だけで在庫を自動復活させない。不良品・返品の再販売可否を確認し、必要なら管理者が監査記録を残して調整する。管理者用の在庫増減UIは未実装。
- `review`状態、在庫のマイナス、Webhook配信エラーが発生した場合は、販売を一時停止してStripeとDBを照合する。状態を推測して在庫を戻さない。
- 非同期決済失敗のWebhookが未配信のままの場合、在庫確保が続く可能性がある。StripeのWebhook配信失敗を確認し、原因を修復して再送する。

## 停止・復旧

新規販売停止はWorkerの`SALE_ENABLED=false`を反映する。Webhookと既存注文の確認は継続する。LPは在庫照会に失敗すると購入ボタンを無効にする。

Workerの再デプロイで在庫500を再投入しない。永続DBは初回だけ作成される。名前空間やWorker名の変更、DB削除は在庫リセットになるため、本番運用中に行わない。

## ローカル検証

`node --test test/*.test.mjs`で共有在庫・再試行・通知順序・支払い不整合を検証。

`node node_modules/wrangler/bin/wrangler.js deploy --dry-run`でバンドル確認。これは公開も実決済も行わない。

2026-10-20検証済み:

- 自動テスト15件成功。SQLiteによる同時在庫確保、再試行、通知順序、金額不整合、テスト/本番分離を確認。
- 模擬APIの画面試験は320/390/1440pxで横溢れなし。通信失敗から同じ注文IDで再試行できる。
- 実際のTurnstileを使用したLP購入確認画面は320/390pxで認証成功。横溢れなし。これはスマホ幅の確認であり、実機スマホでのStripe決済完了確認とは別。
- 実Stripe Sandboxで3袋1,280円、10袋3,980円、30袋10,500円がすべて `paid`、在庫記録も `paid`。500袋から計43袋を消費して457袋となった。**本番在庫には影響しない**。
- 失敗カードは拒否され、注文完了にならない。LPへ戻って同じセットを再開すると同じCheckout Sessionが再利用される。
- 別の30袋Checkoutを期限切れにし、Webhookで30袋が戻ることを確認。終了済みの案内後に再試行すると新しいCheckoutが作られる。
- 決済完了Webhookを再送しても二重減算なし。未処理Webhook数0を確認。
- 配送先・氏名・電話番号・メール・販売条件への同意をStripeに記録。国内配送JPのみ。
- 不許可Origin、無効Turnstile、無署名Webhookはそれぞれ403/403/400で拒否。

実機スマホ・本番決済の確認はSandbox試験とは別に行う。
