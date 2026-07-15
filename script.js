const stripeLinks = {
  trial_1: "",
  pack_10: "",
  sub_10: "",
  pack_30: "",
  sub_30: "",
};

const purchasesEnabled = false;
const launchInterestEndpoint = ""; // Google Apps ScriptのウェブアプリURLを入れる
const crowdfundingUrl = "https://camp-fire.jp/projects/960093/idea";
const launchStorageKey = "bodyMakeChipsLaunchInterest";
const launchClientIdKey = "bodyMakeChipsLaunchClientId";

let selectedPlan = "";

const plans = [...document.querySelectorAll("[data-stripe-plan]")];
const checkoutButtons = [...document.querySelectorAll("[data-checkout-selected]")];
const featureDetails = [...document.querySelectorAll(".feature-detail")];
const featureCloseButtons = [...document.querySelectorAll(".feature-close")];
const crowdfundingButtons = [...document.querySelectorAll("[data-crowdfunding]")];
const launchSection = document.querySelector("#launch-interest");
const launchInterestButton = document.querySelector("[data-launch-interest]");
const launchEmailForm = document.querySelector("[data-launch-email-form]");
const launchStatus = document.querySelector("[data-launch-status]");

function readLaunchData() {
  try {
    return JSON.parse(localStorage.getItem(launchStorageKey)) || { clicks: 0, emails: [] };
  } catch {
    return { clicks: 0, emails: [] };
  }
}

function writeLaunchData(data) {
  localStorage.setItem(launchStorageKey, JSON.stringify(data));
}

function getLaunchClientId() {
  let clientId = localStorage.getItem(launchClientIdKey);

  if (!clientId) {
    clientId = window.crypto && typeof window.crypto.randomUUID === "function"
      ? window.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(launchClientIdKey, clientId);
  }

  return clientId;
}

function createLaunchEventId(type) {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildLaunchPayload(payload) {
  return {
    ...payload,
    eventId: payload.eventId || createLaunchEventId(payload.type || "launch_event"),
    clientId: getLaunchClientId(),
    pageUrl: location.href,
    referrer: document.referrer,
    userAgent: navigator.userAgent,
  };
}

function sendLaunchEvent(payload) {
  if (!launchInterestEndpoint) return;

  fetch(launchInterestEndpoint, {
    method: "POST",
    mode: "no-cors",
    keepalive: true,
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(buildLaunchPayload(payload)),
  }).catch(() => {
    // Local保存を優先し、外部送信の失敗では体験を止めない。
  });
}

function setLaunchStatus(message) {
  if (launchStatus) launchStatus.textContent = message;
}

function showLaunchAfter() {
  if (launchSection) launchSection.classList.add("is-responded");
}

function recordLaunchInterest() {
  const data = readLaunchData();
  data.clicks = (data.clicks || 0) + 1;
  data.lastClickedAt = new Date().toISOString();
  data.emails = Array.isArray(data.emails) ? data.emails : [];
  writeLaunchData(data);
  sendLaunchEvent({ type: "interest_click", localClicks: data.clicks, at: data.lastClickedAt });
  showLaunchAfter();
  setLaunchStatus("1票を受け付けました。");
}

function selectPlan(planId) {
  selectedPlan = planId;
  plans.forEach((button) => {
    const card = button.closest(".plan");
    card.classList.toggle("is-selected", button.dataset.stripePlan === planId);
  });
}

function checkout() {
  if (!purchasesEnabled) {
    alert("BODY-MAKE CHIPSは現在、発売準備中です。予約・購入・支払いは発生しません。試してみたい方は、ページ内の1票ボタンからお知らせください。");
    return;
  }

  const url = stripeLinks[selectedPlan];

  if (!selectedPlan) {
    alert("プランを選択してください。");
    return;
  }

  if (!url) {
    alert("Stripeの決済リンクを設定してください。script.js の stripeLinks に各プランのURLを入れると遷移します。");
    return;
  }

  window.location.href = url;
}

function syncPurchaseState() {
  if (!purchasesEnabled) return;

  document.querySelectorAll(".purchase-disabled").forEach((section) => {
    section.classList.remove("purchase-disabled");
  });

  document.querySelectorAll("[data-stripe-plan], [data-checkout-selected]").forEach((button) => {
    button.disabled = false;
    button.classList.remove("button--disabled");
    if (button.dataset.readyLabel) button.textContent = button.dataset.readyLabel;
  });
}

plans.forEach((button) => {
  button.addEventListener("click", () => selectPlan(button.dataset.stripePlan));
});

checkoutButtons.forEach((button) => {
  button.addEventListener("click", checkout);
});

crowdfundingButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (crowdfundingUrl) {
      window.location.href = crowdfundingUrl;
      return;
    }

    alert("クラウドファンディングページは現在準備中です。公開後、ここから遷移できるようにします。");
  });
});

if (launchInterestButton) {
  launchInterestButton.addEventListener("click", recordLaunchInterest);
}

if (launchEmailForm) {
  launchEmailForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(launchEmailForm);
    const email = String(formData.get("email") || "").trim();

    if (!email) {
      setLaunchStatus("メールアドレスは未入力です。クリックのみ記録済みです。");
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setLaunchStatus("メールアドレスの形式を確認してください。");
      return;
    }

    const data = readLaunchData();
    data.emails = Array.isArray(data.emails) ? data.emails : [];
    const alreadyStored = data.emails.some((entry) => entry.email === email);

    if (!alreadyStored) {
      const entry = { email, at: new Date().toISOString() };
      data.emails.push(entry);
      data.lastEmailAt = entry.at;
      writeLaunchData(data);
      sendLaunchEvent({ type: "email_opt_in", email, localClicks: data.clicks || 0, at: entry.at });
    }

    launchEmailForm.reset();
    setLaunchStatus("販売開始の通知希望を受け付けました。");
  });
}

featureDetails.forEach((detail) => {
  detail.addEventListener("toggle", () => {
    if (!detail.open) return;

    detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
});

featureCloseButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const detail = button.closest(".feature-detail");
    if (detail) detail.open = false;
  });
});

if (selectedPlan) selectPlan(selectedPlan);

syncPurchaseState();

if (readLaunchData().clicks > 0) showLaunchAfter();

window.bodyMakeChipsLaunchData = () => readLaunchData();
