// Verifies the Signature header hlthstack sends with every webhook, using node:crypto only.
// The header is an HS256 JWT signed with your webhook secret. It has no `exp` and does not
// cover the body, so check the signature, the timestamp and that the ids match the body.
import { createHmac, timingSafeEqual } from 'node:crypto';

export class WebhookError extends Error {}

const decodeJson = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/**
 * Returns the JWT claims, or throws WebhookError. `body` is the parsed JSON body.
 * toleranceSeconds: how far the `timestamp` claim may be from now (default 5 minutes).
 */
export function verifyWebhook(signature, body, secret, { toleranceSeconds = 300, now = Date.now() / 1000 } = {}) {
  const parts = String(signature ?? '').split('.');
  if (parts.length !== 3) throw new WebhookError('missing or malformed Signature');
  const [header, payload, sig] = parts;

  // 1. HS256 only, and a valid signature for your secret.
  let alg, claims;
  try {
    ({ alg } = decodeJson(header));
    claims = decodeJson(payload);
  } catch {
    throw new WebhookError('malformed Signature');
  }
  if (alg !== 'HS256') throw new WebhookError('unexpected algorithm');
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(sig, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new WebhookError('invalid signature');
  }

  // 2. A recent timestamp (Unix seconds), to block replays.
  if (typeof claims.timestamp !== 'number' || Math.abs(now - claims.timestamp) > toleranceSeconds) {
    throw new WebhookError('stale or missing timestamp');
  }

  // 3. The ids in the claims match the body.
  let matches;
  if (claims.order_id !== undefined) {
    // pharmacy: order_id, and webhook_type equals the body's type
    matches = claims.order_id === body.order_id && claims.webhook_type === body.type;
  } else if (claims.request_id !== undefined) {
    // prescription digitization
    matches = claims.request_id === body.request_id;
  } else {
    // appointments, consultations, lab results
    matches = Boolean(claims.appointment_id) && claims.appointment_id === body.appointment_id &&
      claims.booking_id === body.booking_id;
  }
  if (!matches) throw new WebhookError('claims do not match the body');
  return claims;
}
