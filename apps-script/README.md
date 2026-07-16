# お問い合わせ用Google Apps Scriptの設定

`Code.gs`は、BODY-MAKE BASEのお問い合わせフォームから送信された内容を受け取り、管理者通知、自動返信、Googleスプレッドシートへの保存を行う参考コードです。

## 設定手順

1. `apps-script/Code.gs`の内容を、作成済みのGoogle Apps Scriptプロジェクトの`Code.gs`へ貼り付けます。
2. `ADMIN_EMAIL`へ、問い合わせ通知を受け取る管理者メールアドレスを設定します。
3. Googleドライブで、問い合わせ保存用のGoogleスプレッドシートを作成します。
4. スプレッドシートURLの`/d/`と`/edit`の間にあるIDを、`SPREADSHEET_ID`へ設定します。
5. Apps Scriptの「デプロイ」から「新しいデプロイ」を選び、種類を「ウェブアプリ」にします。
6. 「次のユーザーとして実行」は「自分」を選択します。
7. 「アクセスできるユーザー」は「全員」を選択します。
8. デプロイ後に発行されたウェブアプリURLを、リポジトリ直下の`script.js`にある`contactFormEndpoint`へ設定します。
9. `contact.html`を開き、実在する受信可能なメールアドレスを使ってテスト送信します。
10. 管理者通知メール、自動返信メール、スプレッドシートへの1行保存を確認します。

## 設定する定数

```javascript
const ADMIN_EMAIL = "ここに管理者メールアドレスを入力";
const SPREADSHEET_ID = "ここにスプレッドシートIDを入力";
const SHEET_NAME = "お問い合わせ";
```

`SHEET_NAME`と同名のシートが存在しない場合、初回送信時に自動作成されます。先頭行には次の列見出しが追加されます。

1. 受付日時
2. お問い合わせ種別
3. お名前
4. メールアドレス
5. 注文番号・支援番号
6. お問い合わせ内容
7. ページURL
8. User-Agent

## ウェブアプリURLについて

Apps Scriptを再デプロイした場合、デプロイ方法によってウェブアプリURLが変わることがあります。URLが変わったときは、`script.js`の`contactFormEndpoint`も更新し、再度テスト送信してください。

フロント側はGitHub Pagesから送信できるよう、JSONを`text/plain;charset=utf-8`として`POST`し、`mode: "no-cors"`を使用します。そのためブラウザ側ではApps Scriptのレスポンス本文を読み取らず、`fetch`が拒否されなかった場合に受付完了表示へ切り替えます。
