import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('./', import.meta.url);
const config = JSON.parse(await readFile(new URL('site.config.json', root), 'utf8'));
// Launch requires a separately reviewed checkout implementation and final sales terms.
// Changing a flag alone must never make this static preview accept orders.
if (config.saleStatus !== 'prelaunch') throw new Error('Only prelaunch is implemented. Complete checkout and sales-condition review before adding live mode.');
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const yen = value => new Intl.NumberFormat('ja-JP').format(value);
for (const set of config.sets) {
  if (!Number.isInteger(set.quantity) || set.quantity < 1 || !Number.isInteger(set.price) || set.price < 1 || set.price % set.quantity !== 0) throw new Error('Invalid set pricing');
}
const trial = config.sets.find(set => set.id === 'trial');
const tokens = {
  saleLabel: escape(config.saleLabel),
  notice: escape(config.notice),
  priceLabel: escape(config.priceLabel),
  priceTerms: escape(config.priceTerms),
  trialName: escape(trial.name),
  trialPrice: yen(trial.price),
  saleConfig: JSON.stringify({saleStatus:config.saleStatus}).replace(/</g, '\\u003c'),
  lineupCards: config.sets.map((set, index) => `
          <article id="set-${escape(set.id)}" class="lineup-card${index === 0 ? ' lineup-card--trial' : ''} reveal" tabindex="-1" aria-labelledby="set-${escape(set.id)}-title" style="--reveal-delay:${index * 75}ms">
            <p class="lineup-card__audience">${escape(set.audience)}</p>
            <h3 id="set-${escape(set.id)}-title">${escape(set.name)}</h3>
            <p class="lineup-card__quantity">${config.bagGrams}g × ${escape(set.quantityLabel)}袋</p>
            <p class="lineup-card__price"><strong>${yen(set.price)}</strong><span>円</span></p>
            <p class="lineup-card__terms">${escape(config.priceLabel)}・${escape(config.priceTerms)}</p>
            <p class="lineup-card__unit">１袋あたり${yen(set.price / set.quantity)}円</p>
            <p class="sale-state">${escape(config.saleLabel)}</p>
            <p class="lineup-card__delivery">追跡サービス${set.tracking ? 'あり' : 'なし'}（予定）</p>
            ${set.note ? `<p class="lineup-card__note">${escape(set.note)}</p>` : ''}
          </article>`).join('\n')
};
const template = await readFile(new URL('index.template.html', root), 'utf8');
const html = template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
  if (!(key in tokens)) throw new Error(`Unknown template token: ${key}`);
  return tokens[key];
}).replace(/[ \t]+$/gm, '');
await writeFile(new URL('index.html', root), html);
console.log('Built index.html: prelaunch, 3 sets, no checkout.');
