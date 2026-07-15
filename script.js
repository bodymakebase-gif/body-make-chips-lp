const stripeLinks = {
  trial_1: "",
  pack_10: "",
  sub_10: "",
  pack_30: "",
  sub_30: "",
};

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
