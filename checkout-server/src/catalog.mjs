export const CATALOG = Object.freeze({
  trial: Object.freeze({ bags: 3, amount: 1280, name: 'お試し３袋' }),
  desk: Object.freeze({ bags: 10, amount: 3980, name: '10袋セット' }),
  stock: Object.freeze({ bags: 30, amount: 10500, name: '30袋セット' }),
});
export const INITIAL_STOCK = 500;
export const SHIPPING_START = '2026-11-05';

export class CheckoutError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

export function validateRequest(input) {
  if (!input || !Object.hasOwn(CATALOG, input.setId)) throw new CheckoutError('invalid_set');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.requestId || '')) {
    throw new CheckoutError('invalid_request_id');
  }
  return CATALOG[input.setId];
}
