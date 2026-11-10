import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebhookVerificationError, verifyWebhookSignature, type WebhookPayload } from '../src/index.js';

const SECRET = 'example-webhook-secret';
const NOW = 1_768_440_000;

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

function sign(claims: object, { secret = SECRET, alg = 'HS256' } = {}): string {
  const header = b64url(JSON.stringify({ alg, typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

const appointment = {
  type: 'status_update',
  booking_id: 'EKI0000000001700000000',
  appointment_id: 'APT1A2B3C4D5',
  status: 'confirmed',
};
const appointmentClaims = {
  appointment_id: 'APT1A2B3C4D5',
  booking_id: 'EKI0000000001700000000',
  timestamp: NOW,
  webhook_type: 'status_update',
};

async function reason(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(WebhookVerificationError);
  return (error as WebhookVerificationError).reason;
}

describe('verifyWebhookSignature', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts a valid appointment webhook (raw string body)', async () => {
    const { claims, payload } = await verifyWebhookSignature({
      payload: JSON.stringify(appointment),
      signature: sign(appointmentClaims),
      secret: SECRET,
      now: NOW + 10,
    });
    expect(claims).toEqual(appointmentClaims);
    expect(payload).toEqual(appointment);
  });

  it('accepts parsed bodies and bytes', async () => {
    const signature = sign(appointmentClaims);
    await expect(
      verifyWebhookSignature({ payload: appointment, signature, secret: SECRET, now: NOW }),
    ).resolves.toBeTruthy();
    await expect(
      verifyWebhookSignature({
        payload: new TextEncoder().encode(JSON.stringify(appointment)),
        signature,
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBeTruthy();
  });

  it('accepts lab results, pharmacy and digitization webhooks', async () => {
    const lab = { type: 'lab_results', booking_id: appointment.booking_id, appointment_id: appointment.appointment_id };
    await verifyWebhookSignature({
      payload: lab,
      signature: sign({ ...appointmentClaims, webhook_type: 'lab_results' }),
      secret: SECRET,
      now: NOW,
    });

    const postBilling = { type: 'post_billing', order_id: 'EPO000000000003', service_type: 'pharmacy' };
    const verified = await verifyWebhookSignature({
      payload: postBilling,
      signature: sign({ order_id: 'EPO000000000003', timestamp: NOW, webhook_type: 'post_billing' }),
      secret: SECRET,
      now: NOW,
    });
    const event: WebhookPayload = verified.payload;
    expect(event.type).toBe('post_billing');

    await verifyWebhookSignature({
      payload: { type: 'digitization_results', request_id: 'DIGI_RQ_A1B2C3D4E', status: 'completed' },
      signature: sign({ request_id: 'DIGI_RQ_A1B2C3D4E', timestamp: NOW, webhook_type: 'digitization_results' }),
      secret: SECRET,
      now: NOW,
    });
  });

  it('rejects a wrong secret or tampered claims', async () => {
    expect(
      await reason(
        verifyWebhookSignature({
          payload: appointment,
          signature: sign(appointmentClaims, { secret: 'another-secret' }),
          secret: SECRET,
          now: NOW,
        }),
      ),
    ).toBe('invalid_signature');

    const [h, , s] = sign(appointmentClaims).split('.');
    const forged = `${h}.${b64url(JSON.stringify({ ...appointmentClaims, appointment_id: 'APT000000000' }))}.${s}`;
    expect(
      await reason(verifyWebhookSignature({ payload: appointment, signature: forged, secret: SECRET, now: NOW })),
    ).toBe('invalid_signature');
  });

  it('accepts only HS256', async () => {
    const none = `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify(appointmentClaims))}.`;
    expect(
      await reason(verifyWebhookSignature({ payload: appointment, signature: none, secret: SECRET, now: NOW })),
    ).toBe('unsupported_algorithm');
    expect(
      await reason(
        verifyWebhookSignature({
          payload: appointment,
          signature: sign(appointmentClaims, { alg: 'HS512' }),
          secret: SECRET,
          now: NOW,
        }),
      ),
    ).toBe('unsupported_algorithm');
  });

  it('rejects missing or malformed signatures', async () => {
    expect(await reason(verifyWebhookSignature({ payload: appointment, signature: undefined, secret: SECRET }))).toBe(
      'missing_signature',
    );
    expect(await reason(verifyWebhookSignature({ payload: appointment, signature: 'abc.def', secret: SECRET }))).toBe(
      'malformed_signature',
    );
    expect(
      await reason(verifyWebhookSignature({ payload: appointment, signature: 'a.b!.c', secret: SECRET })),
    ).toBe('malformed_signature');
  });

  it('enforces the timestamp tolerance (default 5 minutes)', async () => {
    const signature = sign(appointmentClaims);
    await expect(
      verifyWebhookSignature({ payload: appointment, signature, secret: SECRET, now: NOW + 300 }),
    ).resolves.toBeTruthy();
    expect(
      await reason(verifyWebhookSignature({ payload: appointment, signature, secret: SECRET, now: NOW + 301 })),
    ).toBe('stale_timestamp');
    expect(
      await reason(verifyWebhookSignature({ payload: appointment, signature, secret: SECRET, now: NOW - 301 })),
    ).toBe('stale_timestamp');
    await expect(
      verifyWebhookSignature({ payload: appointment, signature, secret: SECRET, now: NOW + 500, toleranceSeconds: 600 }),
    ).resolves.toBeTruthy();

    const noTimestamp = sign({ ...appointmentClaims, timestamp: undefined });
    expect(
      await reason(verifyWebhookSignature({ payload: appointment, signature: noTimestamp, secret: SECRET, now: NOW })),
    ).toBe('invalid_timestamp');
  });

  it('checks the claim ids against the body', async () => {
    const signature = sign(appointmentClaims);
    expect(
      await reason(
        verifyWebhookSignature({
          payload: { ...appointment, appointment_id: 'APT9Z9Z9Z9Z9' },
          signature,
          secret: SECRET,
          now: NOW,
        }),
      ),
    ).toBe('id_mismatch');
    expect(
      await reason(
        verifyWebhookSignature({
          payload: { ...appointment, booking_id: 'EKI0000000001700000001' },
          signature,
          secret: SECRET,
          now: NOW,
        }),
      ),
    ).toBe('id_mismatch');

    // pharmacy: webhook_type must match the body's type
    expect(
      await reason(
        verifyWebhookSignature({
          payload: { type: 'status_update', order_id: 'EPO000000000003' },
          signature: sign({ order_id: 'EPO000000000003', timestamp: NOW, webhook_type: 'post_billing' }),
          secret: SECRET,
          now: NOW,
        }),
      ),
    ).toBe('id_mismatch');

    // digitization
    expect(
      await reason(
        verifyWebhookSignature({
          payload: { type: 'digitization_results', request_id: 'DIGI_RQ_OTHER' },
          signature: sign({ request_id: 'DIGI_RQ_A1B2C3D4E', timestamp: NOW, webhook_type: 'digitization_results' }),
          secret: SECRET,
          now: NOW,
        }),
      ),
    ).toBe('id_mismatch');

    // claims without any id never match
    expect(
      await reason(
        verifyWebhookSignature({
          payload: {},
          signature: sign({ timestamp: NOW, webhook_type: 'status_update' }),
          secret: SECRET,
          now: NOW,
        }),
      ),
    ).toBe('id_mismatch');
  });

  it('falls back to node:crypto when Web Crypto is not global (Node 18)', async () => {
    vi.stubGlobal('crypto', undefined);
    expect(globalThis.crypto).toBeUndefined();
    const { claims } = await verifyWebhookSignature({
      payload: appointment,
      signature: sign(appointmentClaims),
      secret: SECRET,
      now: NOW,
    });
    expect(claims.timestamp).toBe(NOW);
  });

  it('rejects bodies that are not JSON objects', async () => {
    expect(
      await reason(
        verifyWebhookSignature({ payload: 'not json', signature: sign(appointmentClaims), secret: SECRET, now: NOW }),
      ),
    ).toBe('invalid_payload');
  });
});
