import { CATALOG, CheckoutError } from './catalog.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CODE = /^Reviewer[a-z0-9]{2,50}$/i;
const PROMOTION_ID = /^promo_[a-z0-9]{1,200}$/i;
// Stripe Products may use a merchant-provided ID rather than a prod_ prefix.
const PRODUCT_ID = /^[-_a-z0-9]{1,200}$/i;
const PURPOSE = 'reviewer';
const forbidden = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const fail = (code = 'reviewer_coupon_invalid', status = 400) => { throw new CheckoutError(code, status); };
const conflict = () => fail('reviewer_coupon_conflict', 409);
const missing = error => error?.statusCode === 404 || error?.status === 404 || error?.code === 'resource_missing';
const bounded = value => Number.isSafeInteger(value) && value >= 1 && value <= 10000;
const questionnaireLabel = value => typeof value === 'string' && value.length <= 80 && !forbidden.test(value) && value.trim() ? value.trim() : null;
const object = input => input && typeof input === 'object' && !Array.isArray(input) ? input : fail();
const operation = value => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : fail();
const couponReference = promotion => promotion?.promotion?.type === 'coupon' ? promotion.promotion.coupon : null;
const referenceId = value => typeof value === 'string' ? value : value?.id;
const managedMetadata = value => value?.bmc_purpose === PURPOSE && value?.bmc_set_id === 'trial';

function createInput(input) {
  object(input);
  if (Object.keys(input).some(key => !['operationId', 'code', 'questionnaire', 'maxRedemptions'].includes(key))) fail();
  const operationId = operation(input.operationId);
  if (typeof input.code !== 'string' || !CODE.test(input.code)) fail();
  const questionnaire = questionnaireLabel(input.questionnaire);
  if (!questionnaire || !bounded(input.maxRedemptions)) fail();
  return { operationId, code: input.code, questionnaire, maxRedemptions: input.maxRedemptions };
}

// Restricted to the product behind the current three-bag price. Questionnaire
// labels are immutable snapshots: updates only deactivate a promotion code.
export class ReviewerCouponService {
  constructor(stripe, config) { this.stripe = stripe; this.config = config; }

  ready() {
    if (typeof this.config?.livemode !== 'boolean') fail('reviewer_coupon_not_ready', 503);
  }

  async trialProduct() {
    this.ready();
    const id = this.config?.prices?.trial;
    if (typeof id !== 'string' || !/^price_[a-z0-9]+$/i.test(id)) fail('reviewer_coupon_not_ready', 503);
    const price = await this.stripe.prices.retrieve(id);
    const product = referenceId(price?.product);
    if (!price || price.id !== id || price.active !== true || price.type !== 'one_time' || price.currency !== 'jpy' ||
        price.unit_amount !== CATALOG.trial.amount || price.livemode !== this.config.livemode ||
        typeof product !== 'string' || !PRODUCT_ID.test(product) || price.product?.deleted) {
      fail('reviewer_coupon_not_ready', 503);
    }
    return product;
  }

  async couponFor(promotion) {
    const reference = couponReference(promotion);
    const id = referenceId(reference);
    if (!id || typeof id !== 'string') conflict();
    return typeof reference === 'object' && reference !== null && reference.applies_to !== undefined ? reference :
      this.stripe.coupons.retrieve(id, { expand: ['applies_to'] });
  }

  validateCoupon(coupon, expected = {}) {
    const metadata = coupon?.metadata;
    const products = coupon?.applies_to?.products;
    const label = questionnaireLabel(metadata?.bmc_questionnaire);
    if (!coupon || coupon.deleted || coupon.livemode !== this.config.livemode || coupon.percent_off !== 100 ||
        coupon.amount_off != null || coupon.duration !== 'once' || !managedMetadata(metadata) || !label ||
        !Array.isArray(products) || products.length !== 1 || typeof products[0] !== 'string' || !PRODUCT_ID.test(products[0]) ||
        !bounded(coupon.max_redemptions) || !CODE.test(metadata.bmc_code || '')) conflict();
    if ((expected.product && products[0] !== expected.product) ||
        (expected.ownerOperationId && metadata.bmc_operation_id !== expected.ownerOperationId) ||
        (expected.code && metadata.bmc_code.toLowerCase() !== expected.code.toLowerCase()) ||
        (expected.questionnaire && label !== expected.questionnaire) ||
        (expected.maxRedemptions && coupon.max_redemptions !== expected.maxRedemptions)) conflict();
    return coupon;
  }

  async managedPromotion(promotion, expected = {}, knownCoupon = null) {
    this.ready();
    const metadata = promotion?.metadata;
    const label = questionnaireLabel(metadata?.bmc_questionnaire);
    if (!promotion || !PROMOTION_ID.test(promotion.id || '') || !CODE.test(promotion.code || '') ||
        promotion.livemode !== this.config.livemode || !managedMetadata(metadata) || !label ||
        !bounded(promotion.max_redemptions) || typeof promotion.active !== 'boolean' ||
        !Number.isSafeInteger(promotion.times_redeemed) || promotion.times_redeemed < 0 ||
        promotion.customer != null || promotion.customer_account != null ||
        promotion.restrictions?.first_time_transaction === true || promotion.restrictions?.minimum_amount != null ||
        (promotion.expires_at != null && (!Number.isSafeInteger(promotion.expires_at) || promotion.expires_at < 0))) conflict();
    if (metadata.bmc_code?.toLowerCase() !== promotion.code.toLowerCase()) conflict();
    if ((expected.code && promotion.code.toLowerCase() !== expected.code.toLowerCase()) ||
        (expected.questionnaire && label !== expected.questionnaire) ||
        (expected.maxRedemptions && promotion.max_redemptions !== expected.maxRedemptions)) conflict();
    const coupon = this.validateCoupon(knownCoupon || await this.couponFor(promotion), {
      ...expected, code: promotion.code, questionnaire: label, maxRedemptions: promotion.max_redemptions,
    });
    if (referenceId(couponReference(promotion)) !== coupon.id) conflict();
    return { id: promotion.id, code: promotion.code, questionnaire: label,
      maxRedemptions: promotion.max_redemptions, timesRedeemed: promotion.times_redeemed,
      active: promotion.active, expiresAt: promotion.expires_at ?? null };
  }

  async list(after = '') {
    this.ready();
    if (after != null && after !== '' && (typeof after !== 'string' || !PROMOTION_ID.test(after))) fail();
    // Pagination follows Stripe's unfiltered page, so even a page containing
    // only unrelated promotions can carry a cursor for the next page.
    const page = await this.stripe.promotionCodes.list({ limit: 50, ...(after ? { starting_after: after } : {}), expand: ['data.promotion.coupon.applies_to'] });
    if (!Array.isArray(page?.data) || typeof page.has_more !== 'boolean') fail('reviewer_coupon_not_ready', 503);
    const items = [];
    for (const promotion of page.data) {
      if (managedMetadata(promotion.metadata)) items.push(await this.managedPromotion(promotion));
    }
    const next = page.has_more && page.data.length ? page.data.at(-1).id : null;
    if (next !== null && !PROMOTION_ID.test(next)) fail('reviewer_coupon_not_ready', 503);
    return { items, next };
  }

  async findCode(input, product) {
    const page = await this.stripe.promotionCodes.list({ code: input.code, limit: 100, expand: ['data.promotion.coupon.applies_to'] });
    if (!Array.isArray(page?.data) || typeof page.has_more !== 'boolean') fail('reviewer_coupon_not_ready', 503);
    if (page.has_more || page.data.length > 1) conflict();
    if (!page.data.length) return null;
    return this.managedPromotion(page.data[0], { ...input, product });
  }

  async create(input) {
    const value = createInput(input), product = await this.trialProduct();
    // A caller-chosen permanent coupon ID outlives Stripe's 24-hour idempotency
    // cache. The stored metadata also detects reusing an operation for new data.
    const couponId = `bmc_reviewer_${value.operationId.replaceAll('-', '')}`;
    let coupon;
    try { coupon = await this.stripe.coupons.retrieve(couponId, { expand: ['applies_to'] }); }
    catch (error) { if (!missing(error)) throw error; }
    if (coupon) this.validateCoupon(coupon, { ...value, product, ownerOperationId: value.operationId });
    const existing = await this.findCode(value, product);
    if (existing) return { coupon: existing };
    const metadata = { bmc_purpose: PURPOSE, bmc_set_id: 'trial', bmc_questionnaire: value.questionnaire,
      bmc_code: value.code.toLowerCase(), bmc_operation_id: value.operationId };
    if (!coupon) {
      try {
        coupon = await this.stripe.coupons.create({ id: couponId, name: 'Reviewer お試し３袋 100%OFF', duration: 'once', percent_off: 100,
          applies_to: { products: [product] }, max_redemptions: value.maxRedemptions, metadata, expand: ['applies_to'] },
        { idempotencyKey: `bmc-reviewer-coupon-${value.operationId}` });
      } catch (error) {
        // A network error may follow a committed coupon write, or its permanent
        // ID may already exist after the idempotency cache expired.
        try { coupon = await this.stripe.coupons.retrieve(couponId, { expand: ['applies_to'] }); }
        catch { throw error; }
      }
      this.validateCoupon(coupon, { ...value, product, ownerOperationId: value.operationId });
      if (coupon.id !== couponId || coupon.metadata.bmc_operation_id !== value.operationId) conflict();
    }
    try {
      const promotion = await this.stripe.promotionCodes.create({ promotion: { type: 'coupon', coupon: coupon.id }, code: value.code,
        max_redemptions: value.maxRedemptions, metadata }, { idempotencyKey: `bmc-reviewer-promotion-${value.operationId}` });
      return { coupon: await this.managedPromotion(promotion, { ...value, product }, coupon) };
    } catch (error) {
      // Recover a lost create response or a concurrent request for the same
      // case-insensitive code. A foreign or changed code fails closed.
      const recovered = await this.findCode(value, product);
      if (recovered) return { coupon: recovered };
      throw error;
    }
  }

  async stop(id, input) {
    this.ready(); object(input);
    if (typeof id !== 'string' || !PROMOTION_ID.test(id) || input.active !== false ||
        Object.keys(input).some(key => !['operationId', 'active'].includes(key))) fail();
    const operationId = operation(input.operationId);
    let promotion;
    try { promotion = await this.stripe.promotionCodes.retrieve(id, { expand: ['promotion.coupon.applies_to'] }); }
    catch (error) { if (missing(error)) fail('reviewer_coupon_not_found', 404); throw error; }
    if (!managedMetadata(promotion?.metadata)) fail('reviewer_coupon_not_found', 404);
    const before = await this.managedPromotion(promotion);
    if (!before.active) return { coupon: before };
    const updated = await this.stripe.promotionCodes.update(id, { active: false },
      { idempotencyKey: `bmc-reviewer-stop-${operationId}` });
    if (updated?.id !== id || updated.active !== false) fail('reviewer_coupon_not_ready', 503);
    return { coupon: await this.managedPromotion(updated, { code: before.code,
      questionnaire: before.questionnaire, maxRedemptions: before.maxRedemptions }) };
  }
}
