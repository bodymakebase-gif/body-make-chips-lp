const contactFormEndpoint = "https://script.google.com/macros/s/AKfycbzDu1ED8vVhgp9NNOkncjxCqCKv2IT2_gz-ue2XgX9XBywKLyAuv_i6cYdbAk1KOxqitg/exec";


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

// The static HTML and this value are both generated from site.config.json.
// No checkout implementation exists in this release; a status change cannot enable orders.
const saleConfigElement = document.querySelector('#sale-config');
if (saleConfigElement) {
  try {
    const saleConfig = JSON.parse(saleConfigElement.textContent);
    document.body.dataset.saleStatus = saleConfig.saleStatus === 'prelaunch' ? saleConfig.saleStatus : 'unavailable';
  } catch { document.body.dataset.saleStatus = 'unavailable'; }
}

const menuToggle = document.querySelector('.menu-toggle');
const siteNav = document.querySelector('.site-nav');
function closeMenu({restoreFocus = false} = {}) {
  if (!menuToggle || !siteNav) return;
  const wasOpen = menuToggle.getAttribute('aria-expanded') === 'true';
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-label', 'メニューを開く');
  siteNav.classList.remove('is-open');
  if (wasOpen && restoreFocus) menuToggle.focus();
}
menuToggle?.addEventListener('click', () => {
  const opening = menuToggle.getAttribute('aria-expanded') !== 'true';
  menuToggle.setAttribute('aria-expanded', String(opening));
  menuToggle.setAttribute('aria-label', opening ? 'メニューを閉じる' : 'メニューを開く');
  siteNav?.classList.toggle('is-open', opening);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeMenu({restoreFocus:true});
});
document.addEventListener('click', event => {
  if (!event.target.closest('.site-header')) closeMenu();
});
document.addEventListener('focusin', event => {
  if (!event.target.closest('.site-header')) closeMenu();
});
window.addEventListener('resize', () => { if (window.innerWidth >= 1040) closeMenu(); });

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
// Without JavaScript (or with reduced motion), copy remains visible. Otherwise
// each reveal waits invisibly until its fixed anchor reaches the viewport center.
if ('IntersectionObserver' in window && !reducedMotion.matches) {
  const pending = new Map();
  let centerObserver;
  let motionResizeFrame = 0;
  let skippedFrame = 0;
  document.querySelectorAll('.reveal').forEach(target => {
    const anchor = document.createElement('span');
    anchor.className = 'motion-trigger';
    anchor.setAttribute('aria-hidden', 'true');
    target.append(anchor);
    target.classList.add('motion-pending');
    pending.set(anchor, {
      animate: () => {
        target.classList.remove('motion-pending');
        target.classList.add('is-animated');
      },
      show: () => target.classList.remove('motion-pending')
    });
  });
  document.querySelectorAll('.fiber-chart').forEach(chart => {
    const addition = chart.querySelector('.bar-fill--addition');
    if (!addition) return;
    chart.classList.add('motion-ready');
    // Observe the fixed track, not the bar whose transform changes its bounds.
    pending.set(addition.parentElement, {
      animate: () => chart.classList.add('is-animated'),
      show: () => chart.classList.remove('motion-ready')
    });
  });
  function finish(anchor, animate) {
    const action = pending.get(anchor);
    if (!action) return;
    pending.delete(anchor);
    centerObserver?.unobserve(anchor);
    action[animate ? 'animate' : 'show']();
  }
  function showSkippedContent() {
    skippedFrame = 0;
    // A deep link or fast jump can pass over the entire observation band.
    // Reveal passed anchors statically, including tall blocks still on screen.
    const upperEdge = window.innerHeight * .38;
    pending.forEach((_action, anchor) => {
      if (anchor.getBoundingClientRect().top < upperEdge) finish(anchor, false);
    });
  }
  function scheduleSkippedContent() {
    if (pending.size && !skippedFrame) skippedFrame = requestAnimationFrame(showSkippedContent);
  }
  function observeAtCenter() {
    motionResizeFrame = 0;
    centerObserver?.disconnect();
    if (reducedMotion.matches) return;
    const height = window.innerHeight;
    centerObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        finish(entry.target, true);
      });
    }, {rootMargin:`-${Math.round(height * .38)}px 0px -${Math.round(height * .43)}px 0px`, threshold:0});
    pending.forEach((_animate, anchor) => centerObserver.observe(anchor));
    showSkippedContent();
  }
  observeAtCenter();
  window.addEventListener('scroll', scheduleSkippedContent, {passive:true});
  document.addEventListener('focusin', event => {
    const target = event.target.closest?.('.motion-pending');
    const anchor = target?.querySelector(':scope > .motion-trigger');
    if (anchor) finish(anchor, false);
  });
  window.addEventListener('resize', () => {
    if (!motionResizeFrame) motionResizeFrame = requestAnimationFrame(observeAtCenter);
  });
  reducedMotion.addEventListener('change', event => {
    if (!event.matches) return;
    centerObserver?.disconnect();
    cancelAnimationFrame(skippedFrame);
    skippedFrame = 0;
    pending.clear();
    document.querySelectorAll('.motion-pending').forEach(target => target.classList.remove('motion-pending'));
    document.querySelectorAll('.motion-ready').forEach(target => target.classList.remove('motion-ready'));
    document.querySelectorAll('.is-animated').forEach(target => target.classList.remove('is-animated'));
  });
}

function resolveAnchor(hash) {
  let id;
  try { id = decodeURIComponent(hash.slice(1)); } catch { return null; }
  if (id === 'nutrition') id = 'nutrition-details';
  const target = document.getElementById(id);
  if (!target) return null;
  if (target.tagName === 'DETAILS') target.open = true;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parent.open = true;
  }
  return target;
}
function scrollToAnchor(hash, {smooth = false, focus = false} = {}) {
  const target = resolveAnchor(hash);
  if (!target) return;
  // The hero and closing CTAs reveal the first card in #lineup, with its section context.
  const focusTarget = target.tagName === 'DETAILS' ? target.querySelector('summary') : target;
  if (focus && focusTarget) {
    if (!focusTarget.matches('a,button,input,summary,[tabindex]')) focusTarget.setAttribute('tabindex', '-1');
    focusTarget.focus({preventScroll:true});
  }
  target.scrollIntoView({behavior:smooth && !reducedMotion.matches ? 'smooth' : 'instant', block:'start'});
}
document.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest('a[href^="#"]');
  if (!link || link.hash.length < 2 || !resolveAnchor(link.hash)) return;
  event.preventDefault();
  closeMenu();
  if (window.location.hash !== link.hash) history.pushState(null, '', link.hash);
  scrollToAnchor(link.dataset.setTarget ? `#set-${link.dataset.setTarget}` : link.hash, {smooth:true,focus:true});
});
window.addEventListener('hashchange', () => scrollToAnchor(window.location.hash, {focus:true}));
if (window.location.hash) {
  resolveAnchor(window.location.hash);
  requestAnimationFrame(() => scrollToAnchor(window.location.hash));
}

const stickyCta = document.querySelector('.sticky-cta');
const hero = document.querySelector('.hero-v2');
const stickyExclusions = [...document.querySelectorAll('#lineup, #ingredients, .comparison-notes, .image-note, #details, #faq, #final-cta, .site-footer')];
let stickyFrame = 0;
function syncStickyCta() {
  stickyFrame = 0;
  if (!stickyCta || !hero) return;
  const headerHeight = document.querySelector('.site-header')?.getBoundingClientRect().height || 0;
  const keyboardVisible = window.visualViewport && window.visualViewport.height < window.innerHeight * .75;
  const editing = document.activeElement?.matches('input,textarea,select,[contenteditable="true"]');
  const overlap = stickyExclusions.some(section => {
    const rect = section.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > headerHeight;
  });
  stickyCta.hidden = window.innerWidth >= 720 || hero.getBoundingClientRect().bottom > headerHeight || overlap || Boolean(keyboardVisible || editing);
}
function scheduleStickyCta() { if (!stickyFrame) stickyFrame = requestAnimationFrame(syncStickyCta); }
window.addEventListener('scroll', scheduleStickyCta, {passive:true});
window.addEventListener('resize', scheduleStickyCta);
window.visualViewport?.addEventListener('resize', scheduleStickyCta);
document.addEventListener('focusin', scheduleStickyCta);
document.addEventListener('focusout', scheduleStickyCta);
document.addEventListener('toggle', scheduleStickyCta, true);
syncStickyCta();

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
