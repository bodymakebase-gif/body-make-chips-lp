import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the actual shipped submit handler and its result helper. No browser,
// network, moderation service or other external account is involved.
const source = readFileSync(new URL('../../reviews-client.js', import.meta.url), 'utf8');
const start = source.indexOf('  function showSubmissionResult(');
const end = source.indexOf('  void loadReviews(1);', start);
assert.ok(start >= 0 && end > start, 'Production review submit helper moved');
const submitCode = source.slice(start, end);
const originalId = '12345678-1234-4234-8234-123456789abc';

function setup({ responses = [], listFailure = false, resetFailure = false } = {}) {
  let handler, resetCount = 0, previewCount = 0, readCount = 0, nextId = 0, tokens = 0;
  const requests = [], listMessages = [];
  const successClasses = new Set();
  const submitStatus = { textContent: '', classList: { add(name) { successClasses.add(name); }, remove(name) { successClasses.delete(name); } }, focus() {} };
  const fields = { disabled: false }, submit = { disabled: false, textContent: '' }, imageStatus = { textContent: '添付済み' };
  const form = {
    addEventListener(name, callback) { assert.equal(name, 'submit'); handler = callback; },
    reportValidity() { return true; },
    reset() { resetCount++; if (resetFailure) throw new Error('local render error'); },
  };
  const values = { name: '投稿者', comment: '食感が好みに合いました。', rating: '4', consent: 'on', website: '' };
  const context = vm.createContext({
    form, fields, submit, submitStatus, imageStatus,
    FormData: class { get(name) { return values[name]; } },
    uuid() { return `aaaaaaaa-aaaa-4aaa-8aaa-${String(++nextId).padStart(12, '0')}`; },
    $() { return { focus() {} }; },
    async verificationToken() { return `fresh-token-${++tokens}`; },
    async api(path, options) {
      requests.push({ path, options, payload: JSON.parse(options.body) });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response || { id: requests.at(-1).payload.submissionId, status: 'published' };
    },
    async loadReviews(page) { assert.equal(page, 1); readCount++; if (listFailure) throw new Error('list read failed'); },
    showListStatus(text) { listMessages.push(text); },
    renderPreviews() { previewCount++; },
    clearWidget() {},
    messageFor() { return '通信を確認してください。'; },
  });
  vm.runInContext(`let submitting = false, processingImages = false, uncertainPayload = null;
    let submissionId = '${originalId}', attachments = [{ mime: 'image/jpeg', data: 'original-picture' }];
    const visitorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    ${submitCode}
    globalThis.state = () => ({ submitting, uncertainPayload, submissionId, attachments });`, context);
  return {
    async send() { await handler({ preventDefault() {} }); await new Promise(resolve => setImmediate(resolve)); },
    state: context.state, requests, listMessages, fields, submit, submitStatus, imageStatus, successClasses,
    resets: () => resetCount, previews: () => previewCount, reads: () => readCount,
  };
}

test('published review success clears the form and refreshes the list and average once', async () => {
  const h = setup(); await h.send();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].path, '/reviews');
  assert.equal(h.requests[0].payload.rating, 4); assert.equal(h.requests[0].payload.consent, true);
  assert.match(h.submitStatus.textContent, /公開しました/);
  assert.equal(h.state().uncertainPayload, null); assert.equal(h.state().attachments.length, 0);
  assert.notEqual(h.state().submissionId, originalId); assert.equal(h.resets(), 1); assert.equal(h.previews(), 1);
  assert.equal(h.reads(), 1); assert.equal(h.fields.disabled, false); assert.equal(h.submit.disabled, false);
});

test('a list refresh failure cannot make a confirmed published write uncertain or repeat it', async () => {
  const h = setup({ listFailure: true }); await h.send();
  assert.equal(h.requests.length, 1); assert.equal(h.reads(), 1);
  assert.equal(h.state().uncertainPayload, null); assert.equal(h.fields.disabled, false);
  assert.match(h.submitStatus.textContent, /公開しました/); assert.ok(h.successClasses.has('is-success'));
  assert.match(h.listMessages[0], /公開済み/); assert.doesNotMatch(h.submit.textContent, /再確認/);
});

test('an original pending submission retry stays a neutral confirmation-waiting receipt', async () => {
  const h = setup({ responses: [{ id: originalId, status: 'pending', duplicate: true }] }); await h.send();
  assert.match(h.submitStatus.textContent, /受付済み/); assert.match(h.submitStatus.textContent, /確認待ち/);
  assert.doesNotMatch(h.submitStatus.textContent, /公開しました/);
  assert.equal(h.requests.length, 1); assert.equal(h.reads(), 0); assert.equal(h.resets(), 1);
  assert.equal(h.state().uncertainPayload, null); assert.equal(h.fields.disabled, false);
});

test('hidden or deleted review retry success does not promise publication or recreate data', async () => {
  const h = setup({ responses: [{ id: originalId, status: 'received', duplicate: true }] }); await h.send();
  assert.match(h.submitStatus.textContent, /現在は公開一覧に表示されていません/);
  assert.doesNotMatch(h.submitStatus.textContent, /公開します|確認待ち/);
  assert.equal(h.reads(), 0); assert.equal(h.requests.length, 1); assert.equal(h.state().uncertainPayload, null);
});

test('a lost write response retries the identical review identity and pictures with a fresh token', async () => {
  const h = setup({ responses: [new Error('connection lost after write')] }); await h.send();
  assert.ok(h.state().uncertainPayload); assert.equal(h.state().submissionId, originalId);
  assert.equal(h.state().attachments.length, 1); assert.equal(h.fields.disabled, true); assert.equal(h.resets(), 0);
  await h.send();
  const [first, second] = h.requests.map(request => request.payload);
  const { turnstileToken: token1, ...review1 } = first, { turnstileToken: token2, ...review2 } = second;
  assert.deepEqual(review2, review1); assert.notEqual(token1, token2);
  assert.equal(h.requests.length, 2); assert.equal(h.state().uncertainPayload, null);
  assert.equal(h.resets(), 1); assert.equal(h.fields.disabled, false);
});

test('unknown or mismatched successful receipts retain the same submission for safe confirmation', async () => {
  for (const response of [{ id: 'different-review', status: 'published' }, { id: originalId, status: 'unexpected' }]) {
    const h = setup({ responses: [response] }); await h.send();
    assert.equal(h.state().submissionId, originalId); assert.ok(h.state().uncertainPayload);
    assert.equal(h.resets(), 0); assert.equal(h.fields.disabled, true); assert.equal(h.reads(), 0);
  }
});

test('an unreadable 2xx body is uncertain, while a definitive client rejection permits editing', async () => {
  const unreadable = setup({ responses: [Object.assign(new Error('invalid JSON response'), { httpStatus: 200 })] });
  await unreadable.send(); assert.ok(unreadable.state().uncertainPayload); assert.equal(unreadable.fields.disabled, true);
  const rejected = setup({ responses: [Object.assign(new Error('invalid review'), { httpStatus: 400 })] });
  await rejected.send(); assert.equal(rejected.state().uncertainPayload, null); assert.equal(rejected.fields.disabled, false);
  assert.equal(rejected.resets(), 0); assert.equal(rejected.state().attachments.length, 1);
});

test('a local display failure after confirmed acceptance never changes the write into a retry', async () => {
  const h = setup({ resetFailure: true }); await h.send();
  assert.match(h.submitStatus.textContent, /送信は完了/);
  assert.equal(h.state().uncertainPayload, null); assert.equal(h.fields.disabled, false);
  assert.equal(h.requests.length, 1); assert.doesNotMatch(h.submit.textContent, /再確認/);
});
