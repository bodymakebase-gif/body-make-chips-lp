const EVENT_SHEET_NAME = "launch_events";
const SUMMARY_SHEET_NAME = "summary";
const EVENT_HEADERS = [
  "receivedAt",
  "type",
  "email",
  "clientId",
  "eventId",
  "localClicks",
  "pageUrl",
  "referrer",
  "userAgent",
  "eventAt",
];

function setup() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const eventSheet = getOrCreateSheet_(spreadsheet, EVENT_SHEET_NAME);
  const summarySheet = getOrCreateSheet_(spreadsheet, SUMMARY_SHEET_NAME);

  if (eventSheet.getLastRow() === 0) {
    eventSheet.appendRow(EVENT_HEADERS);
    eventSheet.setFrozenRows(1);
  }

  summarySheet.clear();
  summarySheet.getRange("A1:B1").setValues([["項目", "数値"]]);
  summarySheet.getRange("A2").setValue("試してみたいクリック数");
  summarySheet.getRange("B2").setFormula(`=COUNTIF(${EVENT_SHEET_NAME}!B:B,"interest_click")`);
  summarySheet.getRange("A3").setValue("通知希望メール数");
  summarySheet.getRange("B3").setFormula(`=COUNTIF(${EVENT_SHEET_NAME}!B:B,"email_opt_in")`);
  summarySheet.getRange("A4").setValue("ユニーク通知希望メール数");
  summarySheet.getRange("B4").setFormula(`=IFERROR(COUNTUNIQUE(FILTER(${EVENT_SHEET_NAME}!C:C,${EVENT_SHEET_NAME}!C:C<>"")),0)`);
  summarySheet.setFrozenRows(1);
}

function doPost(e) {
  const payload = parsePayload_(e);
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet_(spreadsheet, EVENT_SHEET_NAME);

  ensureHeaders_(sheet);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    sheet.appendRow([
      new Date(),
      sanitize_(payload.type),
      sanitize_(payload.email),
      sanitize_(payload.clientId),
      sanitize_(payload.eventId),
      Number(payload.localClicks || 0),
      sanitize_(payload.pageUrl),
      sanitize_(payload.referrer),
      sanitize_(payload.userAgent),
      sanitize_(payload.at),
    ]);
  } finally {
    lock.releaseLock();
  }

  return json_({ ok: true });
}

function doGet(e) {
  if (e && e.parameter && e.parameter.mode === "summary") {
    return json_(getSummary_());
  }

  return json_({
    ok: true,
    message: "BODY-MAKE CHIPS launch tracker is running.",
  });
}

function getSummary_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EVENT_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) {
    return { clicks: 0, emailOptIns: 0, uniqueEmails: 0 };
  }

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, EVENT_HEADERS.length).getValues();
  const emailSet = new Set();
  let clicks = 0;
  let emailOptIns = 0;

  rows.forEach((row) => {
    const type = row[1];
    const email = row[2];

    if (type === "interest_click") clicks += 1;
    if (type === "email_opt_in") {
      emailOptIns += 1;
      if (email) emailSet.add(String(email).toLowerCase());
    }
  });

  return {
    clicks,
    emailOptIns,
    uniqueEmails: emailSet.size,
  };
}

function parsePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};

  try {
    return JSON.parse(e.postData.contents);
  } catch (error) {
    return {};
  }
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(EVENT_HEADERS);
    sheet.setFrozenRows(1);
  }
}

function getOrCreateSheet_(spreadsheet, name) {
  return spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
}

function sanitize_(value) {
  return value == null ? "" : String(value).slice(0, 2000);
}

function json_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
