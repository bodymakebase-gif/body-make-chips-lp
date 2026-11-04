# 購入確認画面の診断計測（2026-11-05）

GA4の本番プロパティ BODY-MAKE CHIPS（560327232）で、導入後の購入操作を計測する。過去の離脱理由は復元できない。すべて通常イベントであり、キーイベントに指定しない。既存の `select_item`、`begin_checkout`、サーバー側 `purchase` の意味は維持する。

同日、購入導線を `auto_v2` に変更した。金額入りの「購入に進む」ボタンを押すと、選択したセット・合計金額・販売条件を表示し、Cloudflare認証の成功後にStripeへ自動で進む。通常時の「お支払いへ進む」クリックを1回省いた。最終的な支払い確定はStripe画面で行い、支払い方法や認証・在庫・価格検証は変更しない。API通信に失敗した場合は新しい認証の成功を待ち、「もう一度試す」を押した時だけ再試行する。自動で繰り返し送信しない。

| イベント | 意味 |
| --- | --- |
| checkout_dialog_open | セットを選択して購入確認画面を開いた |
| checkout_verify_start | 認証待ち開始。期限切れ・通信失敗後の再認証も含む |
| checkout_verify_challenge | Cloudflareが手動認証を要求した |
| checkout_verify_ready | 認証成功。初回は自動で通信へ進み、通信失敗後は明示的な再試行を待つ |
| checkout_verify_slow | 認証待ちが15秒に達した。失敗とは限らない |
| checkout_verify_error | 認証スクリプト・認証処理・非対応ブラウザー等のエラー |
| checkout_verify_expired | 認証トークンの期限切れ |
| checkout_verify_timeout | 手動認証の時間切れ |
| checkout_submit | 決済画面を準備する処理を開始した。初回は認証後に自動、通信失敗後は再試行ボタンから |
| checkout_request_slow | 決済画面の準備が10秒に達した。失敗とは限らない |
| checkout_request_error | API通信・応答・在庫・認証の検証等で進めなかった |
| checkout_redirect | 正しい遷移先を受け取り遷移を要求した。Stripe画面の表示・決済成功の保証ではない。既存注文の確認画面へ戻る場合も含む |
| checkout_dialog_close | 確認画面を閉じた。その時点の段階を記録 |
| checkout_page_exit | 確認画面を開いたままページを離れた観測。戻る場合もあり、購入放棄の確定ではない |
| checkout_availability_error | 在庫・購入可否の照会が失敗した |

## Analyticsでの読み方

「イベント名」で上記イベントを選び、イベントスコープのカスタムディメンションで分ける。

- `checkout_set`（購入セット）: trial / desk / stock。在庫照会時は未選択。
- `checkout_stage`（購入手続きの段階）: verification / ready / request / redirect / error / availability。
- `checkout_issue`（購入手続きのエラー種別）: timeout、network、invalid_response、script_timeout、challenge_failed、verification_failed、out_of_stock等の固定分類。
- `checkout_flow`（購入フロー版）: auto_v2（認証後に自動で進む）。旧 confirm_v1（認証後に「お支払いへ進む」を押す）と区別して比較する。
- `verification_code`（認証エラーコード）: Cloudflareの数値コードのみ。
- `checkout_wait_ms`（購入手続きの待ち時間）: ミリ秒のカスタム指標。認証成功では認証開始から、遷移・通信エラーでは決済準備の開始から、閉じる・離脱では画面を開いてからの経過時間。必ずイベント名を絞って集計する。上限5分。

`http_status` と `checkout_attempt` は追加の診断パラメータ。任意のエラー文、URL、認証トークン、StripeセッションID、注文ID、氏名、住所、電話、メール、カード情報は送らない。

最初に確認するのは、手動認証要求と認証エラーの発生数、通信エラーの内訳、認証待ち時間、購入画面を開いた人からStripeへ進んだ人の割合。イベント数は再試行を含むため人数ではない。ユーザー数とイベント数を分け、同じ期間・流入・端末条件で `checkout_flow` 別に比較する。端末・流入コピーはGA4既存ディメンションと組み合わせる。`begin_checkout` はStripeへの遷移直前の計測であり、Stripe画面の表示確認や購入成功ではない。購入の判断にはサーバー側 `purchase` と受注記録を用いる。

解析拒否・内部アクセス除外・GPC・地域別の同意条件は既存ルールを継承する。広告遮断、通信断、ブラウザーの終了で記録が欠ける場合がある。pagehideは既に解析が起動している場合だけ送信し、配送を保証しない。決済成功・失敗の正本はStripe。通常レポートは定義登録とイベント受信後24〜48時間が目安。

## 実装と確認

`analytics.js` が許可済みのイベントだけを送信する。`tracking/checkout-diagnostics.mjs` がデータを許可リストに絞り、`checkout-client.js` が実際のコールバック・画面操作・API結果から記録する。計測の失敗で購入を止めない。

認証スクリプトの読込は20秒でエラー表示、APIは45秒でタイムアウトする。価格検証・在庫確保・同じリクエストIDでの再試行・サーバーでの認証検証は従来どおり。認証済みトークンの重複通知・閉じた画面の遅延通知・通信失敗後の自動再送は購入開始に使わない。公開前は `node --test checkout-server/test/*.test.mjs` と `node build.mjs` で確認する。本番で架空のエラーや購入イベントを発生させない。

公式資料: [Cloudflareのコールバック](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/)、[GA4カスタム定義](https://support.google.com/analytics/answer/14239696?hl=ja)、[GA4カスタム指標](https://support.google.com/analytics/answer/14239619?hl=ja)。
