const ADMIN_EMAIL = "ここに管理者メールアドレスを入力";
const SPREADSHEET_ID = "ここにスプレッドシートIDを入力";
const SHEET_NAME = "お問い合わせ";

const CONTACT_TYPES = Object.freeze([
  "商品について",
  "クラウドファンディングについて",
  "注文・配送について",
  "定期便について",
  "特定商取引法に基づく開示請求",
  "その他",
]);

const SHEET_HEADERS = Object.freeze([
  "受付日時",
  "お問い合わせ種別",
  "お名前",
  "メールアドレス",
  "注文番号・支援番号",
  "お問い合わせ内容",
  "ページURL",
  "User-Agent",
]);

function doPost(e) {
  try {
    const payload = parsePayload_(e);
    const honeypot = normalizeString_(payload.website, 200, false, "honeypot");

    if (honeypot) {
      console.warn("Honeypotへの入力を検知したため、問い合わせを破棄しました。");
      return createJsonResponse_({ ok: true });
    }

    validateSettings_();
    const contact = validateContact_(payload);
    saveContact_(contact);
    sendContactEmails_(contact);

    return createJsonResponse_({ ok: true });
  } catch (error) {
    const errorMessage = error && error.stack ? error.stack : String(error);
    console.error("問い合わせ処理でエラーが発生しました: " + errorMessage);
    Logger.log("問い合わせ処理でエラーが発生しました: " + errorMessage);
    return createJsonResponse_({ ok: false, error: "CONTACT_PROCESSING_FAILED" });
  }
}

function validateSettings_() {
  if (!ADMIN_EMAIL || ADMIN_EMAIL === "ここに管理者メールアドレスを入力") {
    throw new Error("ADMIN_EMAILが設定されていません。");
  }

  if (!SPREADSHEET_ID || SPREADSHEET_ID === "ここにスプレッドシートIDを入力") {
    throw new Error("SPREADSHEET_IDが設定されていません。");
  }
}

function parsePayload_(e) {
  if (!e || !e.postData || typeof e.postData.contents !== "string" || !e.postData.contents) {
    throw new Error("リクエスト本文がありません。");
  }

  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (_error) {
    throw new Error("JSONの解析に失敗しました。");
  }

  if (!payload || Object.prototype.toString.call(payload) !== "[object Object]") {
    throw new Error("リクエスト形式が正しくありません。");
  }

  return payload;
}

function validateContact_(payload) {
  const contactType = normalizeString_(payload.contactType, 100, true, "お問い合わせ種別");
  if (CONTACT_TYPES.indexOf(contactType) === -1) {
    throw new Error("お問い合わせ種別が正しくありません。");
  }

  const name = normalizeString_(payload.name, 100, true, "お名前");
  const email = normalizeString_(payload.email, 254, true, "メールアドレス").toLowerCase();
  const orderNumber = normalizeString_(payload.orderNumber, 100, false, "注文番号・支援番号");
  const message = normalizeString_(payload.message, 2000, true, "お問い合わせ内容", true);
  const pageUrl = normalizeString_(payload.pageUrl, 2000, true, "ページURL");
  const userAgent = normalizeString_(payload.userAgent, 1000, false, "User-Agent");
  const submittedAtText = normalizeString_(payload.submittedAt, 100, true, "送信日時");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("メールアドレスの形式が正しくありません。");
  }

  if (!/^https?:\/\//i.test(pageUrl)) {
    throw new Error("ページURLの形式が正しくありません。");
  }

  const submittedAt = new Date(submittedAtText);
  if (isNaN(submittedAt.getTime())) {
    throw new Error("送信日時の形式が正しくありません。");
  }

  return {
    receivedAt: new Date(),
    submittedAt: submittedAt,
    contactType: contactType,
    name: name,
    email: email,
    orderNumber: orderNumber,
    message: message,
    pageUrl: pageUrl,
    userAgent: userAgent,
  };
}

function normalizeString_(value, maxLength, required, label, preserveLineBreaks) {
  const normalized = String(value == null ? "" : value)
    .replace(/\u0000/g, "")
    .replace(preserveLineBreaks ? /\r\n?/g : /[\r\n]+/g, preserveLineBreaks ? "\n" : " ")
    .trim();

  if (required && !normalized) {
    throw new Error(label + "が入力されていません。");
  }

  if (normalized.length > maxLength) {
    throw new Error(label + "が最大文字数を超えています。");
  }

  return normalized;
}

function saveContact_(contact) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    let sheet = spreadsheet.getSheetByName(SHEET_NAME);

    if (!sheet) {
      sheet = spreadsheet.insertSheet(SHEET_NAME);
    }

    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, SHEET_HEADERS.length).setValues([SHEET_HEADERS]);
      sheet.setFrozenRows(1);
    }

    sheet.appendRow([
      contact.receivedAt,
      safeSheetText_(contact.contactType),
      safeSheetText_(contact.name),
      safeSheetText_(contact.email),
      safeSheetText_(contact.orderNumber),
      safeSheetText_(contact.message),
      safeSheetText_(contact.pageUrl),
      safeSheetText_(contact.userAgent),
    ]);
  } finally {
    lock.releaseLock();
  }
}

function safeSheetText_(value) {
  const text = String(value == null ? "" : value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function sendContactEmails_(contact) {
  const adminSubject = contact.contactType === "特定商取引法に基づく開示請求"
    ? "【BODY-MAKE BASE】特定商取引法に基づく開示請求"
    : "【BODY-MAKE BASE】新しいお問い合わせ";

  const adminBody = [
    "BODY-MAKE BASEのお問い合わせフォームから新しい連絡がありました。",
    "",
    "受付日時: " + formatDate_(contact.receivedAt),
    "お問い合わせ種別: " + contact.contactType,
    "お名前: " + contact.name,
    "メールアドレス: " + contact.email,
    "注文番号・支援番号: " + (contact.orderNumber || "未入力"),
    "ページURL: " + contact.pageUrl,
    "User-Agent: " + (contact.userAgent || "未取得"),
    "",
    "お問い合わせ内容:",
    contact.message,
  ].join("\n");

  const replyBody = [
    contact.name + " 様",
    "",
    "BODY-MAKE BASEへお問い合わせいただき、ありがとうございます。",
    "お問い合わせを受け付けました。内容を確認のうえ、原則として順次回答いたします。",
    "",
    "お問い合わせ種別:",
    contact.contactType,
    "",
    "お問い合わせ内容:",
    contact.message,
    "",
    "このメールは自動送信です。",
    "このお問い合わせに心当たりがない場合は、このメールを破棄してください。",
  ].join("\n");

  const mailErrors = [];

  try {
    MailApp.sendEmail({
      to: ADMIN_EMAIL,
      subject: adminSubject,
      body: adminBody,
      name: "BODY-MAKE BASE",
      replyTo: contact.email,
    });
  } catch (error) {
    console.error("管理者通知メールの送信に失敗しました: " + error);
    mailErrors.push(error);
  }

  try {
    MailApp.sendEmail({
      to: contact.email,
      subject: "【BODY-MAKE BASE】お問い合わせを受け付けました",
      body: replyBody,
      name: "BODY-MAKE BASE",
    });
  } catch (error) {
    console.error("自動返信メールの送信に失敗しました: " + error);
    mailErrors.push(error);
  }

  if (mailErrors.length > 0) {
    throw new Error("メール送信の一部または全部に失敗しました。");
  }
}

function formatDate_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone() || "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");
}

function createJsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
