// Keep diagnostic payloads categorical. Never forward request bodies, tokens,
// session IDs, URLs or arbitrary exception messages to analytics.
const events = new Set([
  'checkout_dialog_open', 'checkout_verify_start', 'checkout_verify_challenge',
  'checkout_verify_ready', 'checkout_verify_slow', 'checkout_verify_error',
  'checkout_verify_expired', 'checkout_verify_timeout', 'checkout_submit',
  'checkout_request_slow', 'checkout_request_error', 'checkout_redirect',
  'checkout_dialog_close', 'checkout_page_exit', 'checkout_availability_error',
]);
const sets = new Set(['trial', 'desk', 'stock']);
const stages = new Set(['verification', 'ready', 'request', 'redirect', 'error', 'availability']);
const issues = new Set([
  'out_of_stock', 'checkout_unavailable', 'checkout_pending_recovery',
  'verification_failed', 'verification_unavailable', 'sales_closed', 'not_ready',
  'temporarily_unavailable', 'request_conflict', 'invalid_set', 'invalid_request_id',
  'invalid_request', 'request_too_large', 'invalid_content_type', 'invalid_json',
  'invalid_session', 'origin_not_allowed', 'not_found', 'order_needs_review',
  'too_large', 'invalid_signature', 'mode_mismatch',
  'network', 'timeout', 'invalid_response', 'http_error', 'script_load',
  'script_timeout', 'challenge_failed', 'challenge_timeout', 'unsupported_browser',
  'render_failed', 'invalid_destination', 'unknown',
]);

function boundedInteger(value, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

export function diagnosticEvent(name, set, details = {}) {
  if (!events.has(name)) return null;
  const params = { checkout_flow: 'auto_v2' };
  const setId = typeof set === 'string' ? set : set?.id;
  if (sets.has(setId)) params.checkout_set = setId;
  if (!details || typeof details !== 'object') return { name, params };
  if (stages.has(details.stage)) params.checkout_stage = details.stage;
  if (details.issue !== undefined) params.checkout_issue = issues.has(details.issue) ? details.issue : 'unknown';

  const wait = boundedInteger(details.waitMs, 0, 300000);
  const attempt = boundedInteger(details.attempt, 1, 20);
  if (wait !== undefined) params.checkout_wait_ms = wait;
  if (attempt !== undefined) params.checkout_attempt = attempt;
  // A non-HTTP failure has no status. Do not clamp invalid values into a real status.
  if (Number.isInteger(details.httpStatus) && details.httpStatus >= 100 && details.httpStatus <= 599) {
    params.http_status = details.httpStatus;
  }
  const code = details.verificationCode;
  if (typeof code === 'string' && code.length >= 3 && code.length <= 6 && !/[^0-9]/.test(code)) params.verification_code = code;
  return { name, params };
}

export function classifyCheckoutError(error) {
  if (issues.has(error?.code)) return error.code;
  switch (error?.name) {
    case 'TimeoutError':
    case 'AbortError': return 'timeout';
    case 'TypeError': return 'network';
    case 'SyntaxError': return 'invalid_response';
    default: return 'unknown';
  }
}
