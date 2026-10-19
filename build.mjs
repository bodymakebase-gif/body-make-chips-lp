import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('./', import.meta.url);
const config = JSON.parse(await readFile(new URL('site.config.json', root), 'utf8'));
if (!['prelaunch', 'live'].includes(config.saleStatus)) throw new Error('Unknown sale status');
const live = config.saleStatus === 'live';
const checkout = { enabled: live, livemode: true, apiOrigin: config.checkout?.apiOrigin || '', turnstileSiteKey: config.checkout?.turnstileSiteKey || '', sets: config.sets.map(({ id, name, quantity, price }) => ({ id, name, quantity, price })) };
if (live && (!/^https:\/\/[a-z0-9.-]+$/.test(checkout.apiOrigin) || !/^0x[A-Za-z0-9_-]{10,}$/.test(checkout.turnstileSiteKey))) {
  throw new Error('Live checkout requires a verified HTTPS API origin and Turnstile site key.');
}
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const yen = value => new Intl.NumberFormat('ja-JP').format(value);
for (const set of config.sets) {
  if (!Number.isInteger(set.quantity) || set.quantity < 1 || !Number.isInteger(set.price) || set.price < 1) throw new Error('Invalid set pricing');
}
const trial = config.sets.find(set => set.id === 'trial');
const tokens = {
  saleLabel: escape(live ? 'ご注文受付中' : config.saleLabel),
  notice: escape(config.notice),
  priceLabel: escape(live ? '販売価格' : config.priceLabel),
  priceTerms: escape(config.priceTerms),
  trialName: escape(trial.name),
  trialPrice: yen(trial.price),
  saleStateNote: escape(live ? config.notice : `現在、${config.saleLabel}です。`),
  lineupIntro: live ? '３つのセットからお選びください。<br />価格はすべて税込・送料込みです。' : '販売開始に向けて、３つのセットをご用意しています。<br />販売予定価格は、すべて税込・送料込みです。',
  availabilityCopy: escape(live ? config.notice : `現在、${config.saleLabel}です。まだご注文いただけません。`),
  purchaseFaq: escape(live ? `セット一覧からご注文いただけます。${config.notice}` : `現在、${config.saleLabel}です。${config.notice}`),
  purchaseTerms: escape(live ? 'すべて買い切りでのご用意です。' : '販売開始時は、すべて買い切りでのご用意です。'),
  trialRepeatFaq: escape(live ? 'お試し３袋の購入回数に制限は設けていません。' : '販売開始後、お試し３袋の購入回数に制限は設けません。'),
  deliveryFaq: escape(live ? 'お試し３袋・10袋セット・30袋セットのすべてを、追跡サービス付きでお届けします。' : 'お試し３袋・10袋セット・30袋セットのすべてを、追跡サービス付きでお届けする予定です。'),
  legalSaleState: live ? '' : '現在は販売準備中です。販売開始後、',
  saleConfig: JSON.stringify({saleStatus:config.saleStatus,checkout}).replace(/</g, '\\u003c'),
  lineupCards: config.sets.map((set, index) => `
          <article id="set-${escape(set.id)}" class="lineup-card${index === 0 ? ' lineup-card--trial' : ''} reveal" tabindex="-1" aria-labelledby="set-${escape(set.id)}-title" style="--reveal-delay:${index * 75}ms">
            <p class="lineup-card__audience">${escape(set.audience)}</p>
            <h3 id="set-${escape(set.id)}-title">${escape(set.name)}</h3>
            <p class="lineup-card__quantity">${config.bagGrams}g × ${escape(set.quantityLabel)}袋</p>
            <p class="lineup-card__price"><strong>${yen(set.price)}</strong><span>円</span></p>
            <p class="lineup-card__terms">${live ? '販売価格' : escape(config.priceLabel)}・${escape(config.priceTerms)}</p>
            <p class="lineup-card__unit">１袋あたり${set.price % set.quantity ? '約' : ''}${yen(Math.round(set.price / set.quantity))}円</p>
            ${live ? `<button class="buy-button" type="button" data-buy-set="${escape(set.id)}" disabled>在庫を確認中…</button>` : `<p class="sale-state">${escape(config.saleLabel)}</p>`}
            <p class="lineup-card__delivery">追跡サービス${set.tracking ? 'あり' : 'なし'}${live ? '' : '（予定）'}</p>
            ${set.note ? `<p class="lineup-card__note">${escape(set.note)}</p>` : ''}
          </article>`).join('\n')
};
const template = await readFile(new URL('index.template.html', root), 'utf8');
const render = template => template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
  if (!(key in tokens)) throw new Error(`Unknown template token: ${key}`);
  return tokens[key];
}).replace(/[ \t]+$/gm, '');
await writeFile(new URL('index.html', root), render(template));
await writeFile(new URL('legal.html', root), render(await readFile(new URL('legal.template.html', root), 'utf8')));
await writeFile(new URL('checkout-settings.json', root), JSON.stringify(checkout, null, 2) + '\n');
console.log(`Built index.html: ${config.saleStatus}, ${config.sets.length} sets, checkout ${live ? 'enabled' : 'disabled'}.`);
