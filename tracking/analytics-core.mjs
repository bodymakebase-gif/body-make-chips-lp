export function cleanLocation(href) {
  const url = new URL(href);
  const clean = new URL(url.pathname, url.origin);
  // Only campaign labels, never arbitrary query parameters or order/session tokens.
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const value = url.searchParams.get(key);
    if (value && /^[a-zA-Z0-9_.~-]{1,100}$/.test(value)) clean.searchParams.set(key, value);
  }
  return clean.href;
}
export function ecommerceItem(set) {
  return { item_id: set.id, item_name: `BODY-MAKE CHIPS ${set.name}`, item_brand: 'BODY-MAKE CHIPS',
    item_variant: `${set.quantity}袋`, price: set.price, quantity: 1 };
}
