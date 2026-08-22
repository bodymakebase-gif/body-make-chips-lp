const contactFormEndpoint = "https://script.google.com/macros/s/AKfycbzDu1ED8vVhgp9NNOkncjxCqCKv2IT2_gz-ue2XgX9XBywKLyAuv_i6cYdbAk1KOxqitg/exec";
const purchasesEnabled = false;

function endpointIsConfigured() {
  try {
    const endpoint = new URL(contactFormEndpoint);
    return endpoint.protocol === "https:" && endpoint.hostname === "script.google.com" && endpoint.pathname.includes("/macros/s/");
  } catch (_error) {
    return false;
  }
}

async function postToAppsScript(payload) {
  if (!endpointIsConfigured()) throw new Error("送信先が設定されていません。");

  await fetch(contactFormEndpoint, {
    method: "POST",
    mode: "no-cors",
    credentials: "omit",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
}

const menuToggle = document.querySelector(".menu-toggle");
const siteNav = document.querySelector(".site-nav");

function closeMenu() {
  if (!menuToggle || !siteNav) return;
  menuToggle.setAttribute("aria-expanded", "false");
  menuToggle.setAttribute("aria-label", "メニューを開く");
  siteNav.classList.remove("is-open");
  document.body.classList.remove("menu-open");
}

menuToggle?.addEventListener("click", () => {
  const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
  menuToggle.setAttribute("aria-expanded", String(!isOpen));
  menuToggle.setAttribute("aria-label", isOpen ? "メニューを開く" : "メニューを閉じる");
  siteNav?.classList.toggle("is-open", !isOpen);
  document.body.classList.toggle("menu-open", !isOpen);
});

siteNav?.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
window.addEventListener("resize", () => {
  if (window.innerWidth >= 1040) closeMenu();
});

const revealTargets = [...document.querySelectorAll(".reveal")];
if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -8%", threshold: 0.08 });
  revealTargets.forEach((target) => revealObserver.observe(target));
} else {
  revealTargets.forEach((target) => target.classList.add("is-visible"));
}

const noticeForm = document.querySelector("#notice-signup");
if (noticeForm) {
  const noticeEmail = noticeForm.elements.email;
  const noticeButton = noticeForm.querySelector("button[type='submit']");
  const noticeStatus = noticeForm.querySelector("#notice-status");
  let noticeSubmitting = false;

  function setNoticeStatus(message, state = "") {
    if (!noticeStatus) return;
    noticeStatus.textContent = message;
    noticeStatus.classList.toggle("is-success", state === "success");
    noticeStatus.classList.toggle("is-error", state === "error");
  }

  noticeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (noticeSubmitting) return;

    const honeypot = String(noticeForm.elements.website?.value || "").trim();
    const email = String(noticeEmail?.value || "").trim().toLowerCase();

    if (honeypot) {
      noticeForm.reset();
      setNoticeStatus("登録できませんでした。時間をおいて再度お試しください。", "error");
      return;
    }

    if (!email || email.length > 254 || !noticeEmail.validity.valid) {
      noticeEmail?.focus();
      setNoticeStatus("有効なメールアドレスを入力してください。", "error");
      return;
    }

    noticeSubmitting = true;
    if (noticeButton) {
      noticeButton.disabled = true;
      noticeButton.textContent = "登録中…";
    }
    setNoticeStatus("登録しています…");

    try {
      await postToAppsScript({
        contactType: "その他",
        name: "販売開始通知希望",
        email,
        orderNumber: "",
        message: "BODY-MAKE CHIPSの一般販売開始のお知らせを希望します。",
        website: "",
        submittedAt: new Date().toISOString(),
        pageUrl: window.location.href.slice(0, 2000),
        userAgent: navigator.userAgent.slice(0, 1000),
      });
      noticeForm.reset();
      setNoticeStatus("登録を受け付けました。販売開始時にメールでお知らせします。", "success");
    } catch (error) {
      console.error("販売開始通知の登録に失敗しました。", error);
      setNoticeStatus("登録できませんでした。通信環境を確認のうえ、再度お試しください。", "error");
    } finally {
      noticeSubmitting = false;
      if (noticeButton) {
        noticeButton.disabled = false;
        noticeButton.textContent = "登録する";
      }
    }
  });

  noticeEmail?.addEventListener("input", () => setNoticeStatus(""));
}

const contactForm = document.querySelector("#contact-form");
if (contactForm) {
  const allowedContactTypes = [
    "商品について",
    "クラウドファンディングについて",
    "注文・配送について",
    "定期便について",
    "特定商取引法に基づく開示請求",
    "その他",
  ];
  const submitButton = contactForm.querySelector("#contact-submit");
  const submitLabel = submitButton?.querySelector("[data-submit-label]");
  const status = contactForm.querySelector("#contact-status");
  const messageControl = contactForm.elements.message;
  const messageCount = contactForm.querySelector("#contact-message-count");
  let submitting = false;

  if (submitButton) submitButton.disabled = false;

  function updateMessageCount() {
    if (messageControl && messageCount) messageCount.textContent = `${messageControl.value.length} / 2000文字`;
  }

  function setStatus(message, state = "") {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("form-status--success", state === "success");
    status.classList.toggle("form-status--error", state === "error");
  }

  function setFieldError(fieldName, message) {
    const field = contactForm.querySelector(`[data-field="${fieldName}"]`);
    if (!field) return;
    const control = field.querySelector("input, select, textarea");
    const error = field.querySelector(".form-error");
    field.classList.toggle("is-invalid", Boolean(message));
    if (message) control?.setAttribute("aria-invalid", "true");
    else control?.removeAttribute("aria-invalid");
    if (error) error.textContent = message;
  }

  function clearErrors() {
    contactForm.querySelectorAll("[data-field]").forEach((field) => {
      field.classList.remove("is-invalid");
      field.querySelector("input, select, textarea")?.removeAttribute("aria-invalid");
      const error = field.querySelector(".form-error");
      if (error) error.textContent = "";
    });
  }

  function validate() {
    clearErrors();
    const contactType = String(contactForm.elements.contactType?.value || "").trim();
    const name = String(contactForm.elements.name?.value || "").trim();
    const email = String(contactForm.elements.email?.value || "").trim();
    const orderNumber = String(contactForm.elements.orderNumber?.value || "").trim();
    const message = String(contactForm.elements.message?.value || "").trim();
    const consent = Boolean(contactForm.elements.consent?.checked);
    const errors = [];

    if (!allowedContactTypes.includes(contactType)) errors.push(["contactType", "お問い合わせ種別を選択してください。"]);
    if (!name) errors.push(["name", "お名前を入力してください。"]);
    else if (name.length > 100) errors.push(["name", "お名前は100文字以内で入力してください。"]);
    if (!email) errors.push(["email", "メールアドレスを入力してください。"]);
    else if (email.length > 254 || !contactForm.elements.email.validity.valid) errors.push(["email", "有効なメールアドレスを入力してください。"]);
    if (orderNumber.length > 100) errors.push(["orderNumber", "注文番号・支援番号は100文字以内で入力してください。"]);
    if (!message) errors.push(["message", "お問い合わせ内容を入力してください。"]);
    else if (message.length > 2000) errors.push(["message", "お問い合わせ内容は2000文字以内で入力してください。"]);
    if (!consent) errors.push(["consent", "個人情報の取り扱いへの同意が必要です。"]);
    errors.forEach(([field, error]) => setFieldError(field, error));

    if (errors.length) {
      contactForm.querySelector(".is-invalid input, .is-invalid select, .is-invalid textarea")?.focus();
      setStatus("入力内容を確認してください。", "error");
      return null;
    }

    return { contactType, name, email, orderNumber, message, website: "", submittedAt: new Date().toISOString(), pageUrl: window.location.href.slice(0, 2000), userAgent: navigator.userAgent.slice(0, 1000) };
  }

  messageControl?.addEventListener("input", updateMessageCount);
  contactForm.addEventListener("input", (event) => {
    const field = event.target.closest?.("[data-field]");
    if (field?.dataset.field) setFieldError(field.dataset.field, "");
    setStatus("");
  });

  contactForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    if (String(contactForm.elements.website?.value || "").trim()) {
      contactForm.reset();
      clearErrors();
      updateMessageCount();
      setStatus("送信できませんでした。時間をおいて再度お試しください。", "error");
      return;
    }

    const payload = validate();
    if (!payload) return;
    submitting = true;
    if (submitButton) submitButton.disabled = true;
    if (submitLabel) submitLabel.textContent = "送信しています…";

    try {
      await postToAppsScript(payload);
      contactForm.reset();
      clearErrors();
      updateMessageCount();
      setStatus("お問い合わせを受け付けました。\n内容を確認のうえ、返信まで今しばらくお待ちください。", "success");
    } catch (error) {
      console.error("お問い合わせの送信に失敗しました。", error);
      setStatus("送信できませんでした。通信環境を確認のうえ、再度お試しください。", "error");
    } finally {
      submitting = false;
      if (submitButton) submitButton.disabled = false;
      if (submitLabel) submitLabel.textContent = "送信する";
    }
  });

  updateMessageCount();
}
