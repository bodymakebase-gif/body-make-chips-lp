# BODY-MAKE CHIPS 決済・在庫運用

## 現在の状態

2026-10-20に本番LPで注文受付を開始。3セットとも公開LPから本番Stripe Checkoutへ進めることを確認済み。価格・発送予定・返品条件・国内配送を設定し、在庫500袋を共有する。実際の課金は行っていない。Sandboxでは3セットすべての決済成功・Webhook・在庫連動を確認済み。

Sandbox: `body-make-chips-checkout-sandbox`。ローカルの実接続テストには `http://127.0.0.1:4175` を使用した。`wrangler.toml` は **Sandbox専用**で、本番設定とは分離している。秘密値3種類はCloudflare Secretsへ保存済み。デプロイした版は `5589f56d-1e89-41d9-9c19-6905a1b2650c`。

本番: `body-make-chips-checkout`。専用の `wrangler.live.toml` を使用する。Turnstileは `body-make-chips.jp` 限定。Stripe制限付きキー・Webhook署名キー・Turnstile秘密キーの3種類を本番Cloudflare Secretsへ保存済み。キー値はGitやLPには含まない。本番Workerの版は `cef681a9-f605-47bf-bc68-1b66f8d4907b`。Webhookは `we_1USNCZRzqHvlt8DA4lIvb9kr`。

Stripe本番のセキュリティ申告は、本人の確認・送信承認を得て提出済み。本人確認書類は未提出。Stripe APIで `charges_enabled=true`、`payouts_enabled=false` を確認し、銀行入金が停止中であることを説明したうえで、本人から「先に注文受付を開始する」と明示的な承認を得て公開した。

**残る本人の対応:** [Stripeの本人確認](https://dashboard.stripe.com/acct_1ThYlsRzqHvlt8DA/account/status/tasks/astask_1USM8fRzqHvlt8DAAKTIhlIb)で書類を提出する。銀行口座への売上入金には本人確認の完了が必要。現時点の入金スケジュールは手動。本人確認後、[残高画面](https://dashboard.stripe.com/acct_1ThYlsRzqHvlt8DA/balance/overview)から入金可能額と入金操作を確認する。

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

1. [Stripe本番の取引一覧](https://dashboard.stripe.com/acct_1ThYlsRzqHvlt8DA/payments)で「成功」の支払いを開く。確認に使用した3件の期限切れCheckoutは注文ではない。
2. 商品名・金額・メタデータ `bags`（3/10/30）と、配送先の氏名・住所・電話番号を照合する。支払い待ち・未払いは発送しない。
3. 11月5日から発送する。それ以降の通常注文は入金確認後3営業日以内。ここでいう入金確認は購入者の決済成功を指し、Stripeから銀行口座への入金とは別。Stripeの支払いIDを発送管理に記録し、二重発送を防ぐ。
4. 発送日・追跡番号を記録し、購入者へ発送連絡を行う。発送連絡の自動化は未実装。

購入者向けの決済成功時・返金時メールはStripeで有効化し、既定言語を日本語に設定済み。運営者のコミュニケーション設定でも「完了した支払いの領収書 - Email」を有効化済み。実売上のメール到着はまだ検証していないため、メールだけに頼らず取引一覧を確認する。

決済画面の利用規約・特商法は `/legal.html`、プライバシーは `/privacy.html`、問い合わせ先は `/contact.html`。カード明細は `BODY-MAKE CHIPS` / `ボディメイクチップス`。配送先の氏名を利用し、氏名の二重入力は求めない。

決済直後のブラウザー画面だけを発送根拠にしない。Webhookと5分ごとの照合処理で在庫が確定する。受注記録はStripe、在庫DBは注文識別子・袋数・金額・状態のみを保持し、カードや配送先住所を保持しない。

## 在庫と例外

- 購入手続き開始時に35分間確保する。同一注文の再試行は同じ在庫確保とStripe冪等キーを使う。
- 期限切れ・非同期決済失敗は、Stripeの状態を確認して在庫を戻す。通信が不明な場合は確保を維持し、定期照合する。
- 決済成功分は消費済みとして保持する。返金だけで在庫を自動復活させない。不良品・返品の再販売可否を確認し、必要なら管理画面の「返品分を戻す」で調整する。
- `review`状態、在庫のマイナス、Webhook配信エラーが発生した場合は、販売を一時停止してStripeとDBを照合する。状態を推測して在庫を戻さない。
- 非同期決済失敗のWebhookが未配信のままの場合、在庫確保が続く可能性がある。StripeのWebhook配信失敗を確認し、原因を修復して再送する。

## 管理画面から在庫を変更する（2026-10-23追加）

本番URL: <https://body-make-chips-checkout.body-make-chips-checkout.workers.dev/admin/>

専用の管理キーでログインする。管理キーは運営者のPCの `%LOCALAPPDATA%\BODY-MAKE CHIPS\inventory-admin\在庫管理_ログイン情報.txt` に保存。Git、公開LP、Google Driveには保存しない。Stripe・Cloudflareのログインパスワードとは別。ログインは8時間有効で、ログアウトするとその端末のセッションを無効にする。

1. 「販売可能」「購入手続き中」「販売済み」を確認する。購入手続き中の一時確保も差し引いた数量が販売可能数。販売済みは決済成功の累計で、未発送や返金した注文も含まれるため、現物在庫とは区別する。
2. 試供品を取るときは「試供品として取り分ける」を選び、袋数を入力。任意で用途をメモし、「内容を確認する」→「登録する」。セット数ではなく袋数を入力する。
3. 破損・廃棄は減算、追加納品・再販売できる返品は加算。購入手続き中・販売済みの確保分は変更しない。LPと同じDBへ即時反映される。
4. 誤登録は変更履歴の「取り消す」から逆方向の記録を追加する。元の履歴は残る。納品の取り消しなどで既存注文分まで減る場合は拒否する。
5. 通信が途切れた場合は「登録結果を確認」を押す。同じ登録番号で確認するため二重減算しない。登録結果が不明な状態で、別端末から同じ内容を新規登録しない。

在庫は30秒ごとに再取得。「最新の在庫に更新」で手動更新も可能。`review` の注文やマイナス在庫がある場合、手動調整を停止する。注文の発送管理はStripeと発送記録で行い、発送時の二重減算はしない。

実装: 同じDurable Objectに追加テーブル `adjustments`、`admin_sessions`、`admin_login_limits` を作成する。既存在庫・予約・Webhook記録を変更/リセットしない。各調整は在庫更新と履歴保存を同一トランザクションで実行。登録IDで冪等化し、確保済み在庫を保護する。

認証: 256bitのランダム管理キーのSHA-256のみをCloudflare Secret `INVENTORY_ADMIN_KEY_HASH` に保存。サーバーにはキー原文を保存しない。セッションはランダム256bitでDBにはハッシュのみ保存。Cookieは `Secure` / `HttpOnly` / `SameSite=Strict`。同一Originと専用ヘッダーを要求し、認証試行を制限する。管理キーのハッシュを更新すると既存セッションは無効になる。管理画面は販売停止中でも利用可能。

検証: 自動テスト23件成功。Sandboxでブラウザから試供品10袋の減算・取消、APIで重複送信・公開在庫連動・不正Origin/未認証/過剰減算の拒否・ログアウト失効を確認し、テスト在庫は457袋へ復元。本番在庫を用いた増減テストは行わない。320/390px相当のブラウザ幅で入力・確認画面と横溢れなしを確認。

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

本番追加検証:

- 公開LPで3セットとも実際のTurnstileを通過し、本番Checkoutの金額1,280/3,980/10,500円を確認。JPY・1回限り・税込設定。JP配送、氏名・住所・電話番号・メールの入力欄、利用規約への同意を確認。
- 3袋・10袋・30袋の各手続きで、それぞれ在庫497/490/470袋への一時確保を確認。すべて支払いを行わず期限切れにし、Webhookで在庫500袋へ戻ることを確認済み。3件とも未処理Webhook数0。
- 実課金・銀行入金・実機スマホでの決済完了は未検証。スマホ幅320/390pxのLP確認画面と実TurnstileはSandboxで検証済み。
