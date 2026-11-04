import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticEvent, classifyCheckoutError } from '../../tracking/checkout-diagnostics.mjs';

test('checkout diagnostics retain only approved labels and bounded diagnostic numbers', () => {
  assert.deepEqual(diagnosticEvent('checkout_request_error', { id: 'trial', name: 'not collected' }, {
    stage: 'request', issue: 'verification_failed', waitMs: 1542.6, attempt: 2, httpStatus: 403,
    verificationCode: '600010',
  }), {
    name: 'checkout_request_error',
    params: { checkout_flow: 'auto_v2', checkout_set: 'trial', checkout_stage: 'request',
      checkout_issue: 'verification_failed', checkout_wait_ms: 1543, checkout_attempt: 2,
      http_status: 403, verification_code: '600010' },
  });
});

test('arbitrary errors, customer data, URLs and session identifiers cannot enter the payload', () => {
  const secret = 'cs_live_private_token/name@example.com';
  const result = diagnosticEvent('checkout_verify_error', { id: secret, email: secret }, {
    stage: secret, issue: secret, verificationCode: secret, error: new Error(secret), message: secret,
    requestId: secret, token: secret, email: secret, page_location: `https://example.com/${secret}`,
    checkout_flow: secret, checkout_set: 'trial', checkout_issue: secret,
  });
  assert.deepEqual(result, { name: 'checkout_verify_error', params: { checkout_flow: 'auto_v2', checkout_issue: 'unknown' } });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(diagnosticEvent(secret, 'trial'), null);
  assert.equal(diagnosticEvent('purchase', 'trial'), null);
});

test('diagnostic numerical bounds do not admit NaN, infinity or arbitrary numeric strings', () => {
  const values = [undefined, null, NaN, Infinity, -Infinity, '45000', {}, []];
  for (const value of values) {
    assert.deepEqual(diagnosticEvent('checkout_verify_slow', null, {
      waitMs: value, attempt: value, httpStatus: value,
    }).params, { checkout_flow: 'auto_v2' });
  }
  assert.deepEqual(diagnosticEvent('checkout_verify_slow', 'desk', { waitMs: -1, attempt: 0 }).params,
    { checkout_flow: 'auto_v2', checkout_set: 'desk', checkout_wait_ms: 0, checkout_attempt: 1 });
  assert.deepEqual(diagnosticEvent('checkout_request_slow', 'stock', { waitMs: 900000, attempt: 99 }).params,
    { checkout_flow: 'auto_v2', checkout_set: 'stock', checkout_wait_ms: 300000, checkout_attempt: 20 });
  for (const httpStatus of [0, 99, 600, 403.5]) {
    assert.equal(Object.hasOwn(diagnosticEvent('checkout_request_error', 'trial', { httpStatus }).params, 'http_status'), false);
  }
  for (const verificationCode of ['12', '1234567', '12a456', ' 600010', '600010\n', '123\n', 600010]) {
    assert.equal(Object.hasOwn(diagnosticEvent('checkout_verify_error', 'trial', { verificationCode }).params, 'verification_code'), false);
  }
});

test('known checkout stages work without a selected set and malformed details are ignored', () => {
  for (const details of [undefined, null, 123, 'private', false]) {
    assert.deepEqual(diagnosticEvent('checkout_availability_error', undefined, details), {
      name: 'checkout_availability_error', params: { checkout_flow: 'auto_v2' },
    });
  }
  assert.deepEqual(diagnosticEvent('checkout_availability_error', undefined, { stage: 'availability', issue: 'mode_mismatch' }).params,
    { checkout_flow: 'auto_v2', checkout_stage: 'availability', checkout_issue: 'mode_mismatch' });
});

test('failure classification uses approved codes or names and never exception messages', () => {
  assert.equal(classifyCheckoutError({ code: 'out_of_stock', name: 'TypeError' }), 'out_of_stock');
  assert.equal(classifyCheckoutError({ code: 'temporarily_unavailable' }), 'temporarily_unavailable');
  assert.equal(classifyCheckoutError({ code: 'mode_mismatch' }), 'mode_mismatch');
  assert.equal(classifyCheckoutError({ name: 'TimeoutError' }), 'timeout');
  assert.equal(classifyCheckoutError({ name: 'AbortError' }), 'timeout');
  assert.equal(classifyCheckoutError(new TypeError('private request URL')), 'network');
  assert.equal(classifyCheckoutError(new SyntaxError('private response body')), 'invalid_response');
  for (const error of [undefined, null, 'timeout', {}, new Error('out_of_stock'), { code: 'customer@example.com', name: 'customer@example.com' }]) {
    assert.equal(classifyCheckoutError(error), 'unknown');
  }
});
