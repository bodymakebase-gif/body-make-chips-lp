// These fields must come from an authenticated Stripe read, never from the LP.
export const checkoutExpansions = ['discounts.coupon.applies_to', 'discounts.promotion_code', 'line_items'];

export function checkoutPricing(session, row) {
  if (session.currency !== 'jpy' || session.mode !== 'payment' ||
      session.metadata?.set_id !== row.set_id || session.metadata?.bags !== String(row.bags) ||
      !Number.isSafeInteger(session.amount_total) || session.amount_total < 0 || session.amount_total > row.amount) {
    throw new Error('Order integrity mismatch');
  }
  const total = session.amount_total;
  const discount = session.total_details?.amount_discount ?? 0;
  if (!Number.isSafeInteger(discount) || discount < 0 || total + discount !== row.amount ||
      (session.total_details?.amount_shipping ?? 0) !== 0 || (session.total_details?.amount_tax ?? 0) !== 0) {
    throw new Error('Order discount mismatch');
  }
  let reviewerCode = null, questionnaire = null, promotionId = null;
  if (discount > 0) {
    const line = session.line_items?.data?.[0];
    const applied = session.discounts;
    if (!(row.checkout_version >= 2) || session.amount_subtotal !== row.amount ||
        session.line_items?.has_more || session.line_items?.data?.length !== 1 ||
        line?.quantity !== 1 || line?.price?.id !== row.price_id || line?.amount_subtotal !== row.amount ||
        !Array.isArray(applied) || applied.length !== 1) throw new Error('Order discount mismatch');
    const promo = applied[0].promotion_code;
    const coupon = applied[0].coupon && typeof applied[0].coupon === 'object' ? applied[0].coupon : promo?.promotion?.coupon;
    if (!promo || typeof promo !== 'object' || !coupon || typeof coupon !== 'object' || coupon.deleted ||
        promo.livemode !== session.livemode || coupon.livemode !== session.livemode ||
        typeof promo.code !== 'string') throw new Error('Unverified promotion code');
    const meta = promo.metadata || {};
    if (row.promotion_code_id || meta.bmc_purpose === 'reviewer' || /^Reviewer/i.test(promo.code)) {
      const product = typeof line.price.product === 'string' ? line.price.product : line.price.product?.id;
      const recorded = row.promotion_code_id === promo.id;
      const label = recorded ? row.questionnaire : meta.bmc_questionnaire;
      if ((!recorded && (meta.bmc_purpose !== 'reviewer' || meta.bmc_set_id !== 'trial')) || row.set_id !== 'trial' || total !== 0 ||
          coupon.percent_off !== 100 || coupon.duration !== 'once' || !product ||
          coupon.applies_to?.products?.length !== 1 || coupon.applies_to.products[0] !== product ||
          typeof label !== 'string' || !label.trim() || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
        throw new Error('Reviewer order mismatch');
      }
      reviewerCode = recorded ? row.reviewer_code : promo.code; questionnaire = label.trim(); promotionId = promo.id;
    }
  }
  if (total === 0 && !reviewerCode) throw new Error('Unrecognized free order');
  const pricing = { amount_total: total, amount_discount: discount, reviewer_code: reviewerCode,
    questionnaire, promotion_code_id: promotionId };
  // Once accepted, a later metadata edit must never silently change packing instructions.
  if (row.state === 'paid' || row.status) {
    if ((row.amount_total ?? row.amount) !== total || (row.amount_discount ?? 0) !== discount ||
        (row.reviewer_code ?? null) !== reviewerCode || (row.questionnaire ?? null) !== questionnaire ||
        (row.promotion_code_id ?? null) !== promotionId) throw new Error('Recorded order mismatch');
  }
  return pricing;
}

export function checkoutComplete(session, pricing) {
  return session.status === 'complete' && (session.payment_status === 'paid' ||
    (session.payment_status === 'no_payment_required' && pricing.amount_total === 0));
}

export async function retrieveCheckout(stripe, id) {
  let session = await stripe.checkout.sessions.retrieve(id);
  // Normal orders retain their existing permissions and request shape. Coupon
  // expansion is needed only for orders that actually received a discount.
  if ((session.total_details?.amount_discount ?? 0) > 0) {
    session = await stripe.checkout.sessions.retrieve(id, { expand: checkoutExpansions });
  }
  if ((session.total_details?.amount_discount ?? 0) > 0 && Array.isArray(session.discounts)) {
    // applies_to is an optional expansion, even when the Coupon itself is
    // expanded. Fetching it separately avoids Stripe's four-level depth limit.
    const discounts = await Promise.all(session.discounts.map(async applied => {
      const indirect = applied.promotion_code?.promotion?.coupon;
      const reference = typeof applied.coupon === 'object' && applied.coupon?.applies_to ? applied.coupon :
        (typeof indirect === 'object' && indirect?.applies_to ? indirect : applied.coupon || indirect);
      if (!reference) return applied;
      const coupon = typeof reference === 'object' && reference.applies_to ? reference :
        await stripe.coupons.retrieve(typeof reference === 'string' ? reference : reference.id, { expand: ['applies_to'] });
      return { ...applied, coupon };
    }));
    return { ...session, discounts };
  }
  return session;
}
