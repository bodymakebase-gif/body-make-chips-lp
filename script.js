const stripeLinks = {
  trial_1: "",
  pack_10: "",
  sub_10: "",
  pack_30: "",
  sub_30: "",
};

const contactFormEndpoint = "https://script.google.com/macros/s/AKfycbzDu1ED8vVhgp9NNOkncjxCqCKv2IT2_gz-ue2XgX9XBywKLyAuv_i6cYdbAk1KOxqitg/exec";

const purchasesEnabled = false;

let selectedPlan = "";

const plans = [...document.querySelectorAll("[data-stripe-plan]")];
const checkoutButtons = [...document.querySelectorAll("[data-checkout-selected]")];
const featureDetails = [...document.querySelectorAll(".feature-detail")];
const featureCloseButtons = [...document.querySelectorAll(".feature-close")];

function selectPlan(planId) {
  if (!purchasesEnabled) return;

  selectedPlan = planId;
  plans.forEach((button) => {
    const card = button.closest(".plan");
    if (card) card.classList.toggle("is-selected", button.dataset.stripePlan === planId);
  });
}

function checkout() {
  if (!purchasesEnabled) return;

  if (!selectedPlan) {
    alert("プランを選択してください。");
    return;
  }

  const url = stripeLinks[selectedPlan];

  if (!url) {
    alert("一般販売の決済ページは現在準備中です。");
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
    button.removeAttribute("aria-disabled");
    button.classList.remove("button--disabled");
  });
}

plans.forEach((button) => {
  button.addEventListener("click", () => selectPlan(button.dataset.stripePlan));
});

checkoutButtons.forEach((button) => {
  button.addEventListener("click", checkout);
});

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

syncPurchaseState();

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
  const contactSubmitButton = contactForm.querySelector("#contact-submit");
  const contactSubmitLabel = contactSubmitButton?.querySelector("[data-submit-label]");
  const contactStatus = contactForm.querySelector("#contact-status");
  const contactMessage = contactForm.elements.message;
  const contactMessageCount = contactForm.querySelector("#contact-message-count");
  let contactFormSubmitting = false;

  if (contactSubmitButton) contactSubmitButton.disabled = false;

  function updateContactMessageCount() {
    if (!contactMessage || !contactMessageCount) return;
    contactMessageCount.textContent = `${contactMessage.value.length} / 2000文字`;
  }

  function setContactStatus(message, state = "") {
    if (!contactStatus) return;

    contactStatus.textContent = message;
    contactStatus.classList.toggle("form-status--success", state === "success");
    contactStatus.classList.toggle("form-status--error", state === "error");
  }

  function setContactFieldError(fieldName, message) {
    const field = contactForm.querySelector(`[data-field="${fieldName}"]`);
    if (!field) return;

    const control = field.querySelector("input, select, textarea");
    const error = field.querySelector(".form-error");
    field.classList.toggle("is-invalid", Boolean(message));

    if (control) {
      if (message) {
        control.setAttribute("aria-invalid", "true");
      } else {
        control.removeAttribute("aria-invalid");
      }
    }

    if (error) error.textContent = message;
  }

  function clearContactFieldErrors() {
    contactForm.querySelectorAll("[data-field]").forEach((field) => {
      const control = field.querySelector("input, select, textarea");
      const error = field.querySelector(".form-error");
      field.classList.remove("is-invalid");
      control?.removeAttribute("aria-invalid");
      if (error) error.textContent = "";
    });
  }

  function validateContactForm() {
    clearContactFieldErrors();

    const contactType = String(contactForm.elements.contactType?.value || "").trim();
    const name = String(contactForm.elements.name?.value || "").trim();
    const email = String(contactForm.elements.email?.value || "").trim();
    const orderNumber = String(contactForm.elements.orderNumber?.value || "").trim();
    const message = String(contactForm.elements.message?.value || "").trim();
    const consent = Boolean(contactForm.elements.consent?.checked);
    const emailControl = contactForm.elements.email;
    const errors = [];

    if (!contactType || !allowedContactTypes.includes(contactType)) {
      errors.push(["contactType", "お問い合わせ種別を選択してください。"]);
    }

    if (!name) {
      errors.push(["name", "お名前を入力してください。"]);
    } else if (name.length > 100) {
      errors.push(["name", "お名前は100文字以内で入力してください。"]);
    }

    if (!email) {
      errors.push(["email", "メールアドレスを入力してください。"]);
    } else if (email.length > 254 || !emailControl?.validity.valid) {
      errors.push(["email", "有効なメールアドレスを入力してください。"]);
    }

    if (orderNumber.length > 100) {
      errors.push(["orderNumber", "注文番号・支援番号は100文字以内で入力してください。"]);
    }

    if (!message) {
      errors.push(["message", "お問い合わせ内容を入力してください。"]);
    } else if (message.length > 2000) {
      errors.push(["message", "お問い合わせ内容は2000文字以内で入力してください。"]);
    }

    if (!consent) {
      errors.push(["consent", "個人情報の取り扱いへの同意が必要です。"]);
    }

    errors.forEach(([fieldName, errorMessage]) => setContactFieldError(fieldName, errorMessage));

    if (errors.length > 0) {
      const firstInvalidField = contactForm.querySelector(".is-invalid input, .is-invalid select, .is-invalid textarea");
      firstInvalidField?.focus();
      setContactStatus("入力内容を確認してください。", "error");
      return null;
    }

    return {
      contactType,
      name,
      email,
      orderNumber,
      message,
      website: "",
      submittedAt: new Date().toISOString(),
      pageUrl: window.location.href.slice(0, 2000),
      userAgent: navigator.userAgent.slice(0, 1000),
    };
  }

  function contactEndpointIsConfigured() {
    try {
      const endpoint = new URL(contactFormEndpoint);
      return endpoint.protocol === "https:" && endpoint.hostname === "script.google.com" && endpoint.pathname.includes("/macros/s/");
    } catch (_error) {
      return false;
    }
  }

  contactMessage?.addEventListener("input", updateContactMessageCount);

  contactForm.addEventListener("input", (event) => {
    const field = event.target.closest?.("[data-field]");
    if (field?.dataset.field) setContactFieldError(field.dataset.field, "");
    if (contactStatus?.textContent) setContactStatus("");
  });

  contactForm.addEventListener("change", (event) => {
    const field = event.target.closest?.("[data-field]");
    if (field?.dataset.field) setContactFieldError(field.dataset.field, "");
  });

  contactForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (contactFormSubmitting) return;

    setContactStatus("");

    const honeypot = String(contactForm.elements.website?.value || "").trim();
    if (honeypot) {
      contactForm.reset();
      clearContactFieldErrors();
      updateContactMessageCount();
      setContactStatus("送信できませんでした。通信環境を確認のうえ、時間をおいて再度お試しください。", "error");
      return;
    }

    const payload = validateContactForm();
    if (!payload) return;

    if (!contactEndpointIsConfigured()) {
      console.warn("contactFormEndpointが設定されていません。");
      setContactStatus("送信できませんでした。通信環境を確認のうえ、時間をおいて再度お試しください。", "error");
      return;
    }

    contactFormSubmitting = true;
    if (contactSubmitButton) contactSubmitButton.disabled = true;
    if (contactSubmitLabel) contactSubmitLabel.textContent = "送信しています…";

    try {
      await fetch(contactFormEndpoint, {
        method: "POST",
        mode: "no-cors",
        credentials: "omit",
        headers: {
          "Content-Type": "text/plain;charset=utf-8",
        },
        body: JSON.stringify(payload),
      });

      contactForm.reset();
      clearContactFieldErrors();
      updateContactMessageCount();
      setContactStatus(
        "お問い合わせを受け付けました。\n内容を確認のうえ、返信まで今しばらくお待ちください。",
        "success",
      );
    } catch (error) {
      console.error("お問い合わせの送信に失敗しました。", error);
      setContactStatus("送信できませんでした。通信環境を確認のうえ、時間をおいて再度お試しください。", "error");
    } finally {
      contactFormSubmitting = false;
      if (contactSubmitButton) contactSubmitButton.disabled = false;
      if (contactSubmitLabel) contactSubmitLabel.textContent = "送信する";
    }
  });

  updateContactMessageCount();
}
