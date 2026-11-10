import { HlthstackBaseError } from './errors.js';
import type { components } from './generated/openapi.js';

type Schemas = components['schemas'];

// ------------------------------------------------------------------ payload types

/** `appointmentStatusUpdate`: a health checkup / lab test appointment changed status or got reports. */
export type AppointmentStatusUpdateWebhook = Schemas['AppointmentDetails'] & {
  type: 'status_update' | 'reports_upload';
};

/** `consultationStatusUpdate`: same envelope as appointments, plus doctor/hospital/meeting fields. */
export type ConsultationStatusUpdateWebhook = Schemas['AppointmentDetails'] & {
  type: 'status_update' | 'reports_upload';
};

/** `labResults`: digitized lab values (separately registered endpoint, enabled on request). */
export type LabResultsWebhook = Schemas['LabResultsPayload'] & { type: 'lab_results' };

type PharmacyEnvelope = Omit<Schemas['PharmacyOrderWebhook'], 'type'>;

/** `pharmacyOrderStatusUpdate`: an ePharmacy order changed status (including refunds). */
export type PharmacyOrderStatusUpdateWebhook = PharmacyEnvelope & { type: 'status_update' };

/** `pharmacyPostBilling`: partner-collected order settled; refund `settlement.adjustment_amount`. */
export type PharmacyPostBillingWebhook = PharmacyEnvelope & {
  type: 'post_billing';
  settlement?: Schemas['PharmacyPostBillingWebhook']['settlement'];
};

/** `pharmacyAdditionalPaymentRequired`: partner-collected order needs `additional_payment.amount_payable`. */
export type PharmacyAdditionalPaymentRequiredWebhook = PharmacyEnvelope & {
  type: 'additional_payment_required';
  additional_payment?: Schemas['PharmacyAdditionalPaymentWebhook']['additional_payment'];
};

/** `prescriptionDigitized`: a prescription digitization request finished. */
export type PrescriptionDigitizedWebhook = Schemas['PrescriptionDigitizedWebhook'] & {
  type: 'digitization_results';
};

/**
 * Any webhook body. Appointment/consultation payloads have `appointment_id`; pharmacy payloads
 * have `order_id` and `service_type: "pharmacy"`; digitization payloads have `request_id`.
 */
export type WebhookPayload =
  | AppointmentStatusUpdateWebhook
  | ConsultationStatusUpdateWebhook
  | LabResultsWebhook
  | PharmacyOrderStatusUpdateWebhook
  | PharmacyPostBillingWebhook
  | PharmacyAdditionalPaymentRequiredWebhook
  | PrescriptionDigitizedWebhook;

/** Claims of the `Signature` JWT. `timestamp` is Unix seconds at send time. */
export type WebhookClaims =
  | {
      appointment_id: string;
      booking_id: string;
      timestamp: number;
      webhook_type: 'status_update' | 'lab_results';
      [claim: string]: unknown;
    }
  | {
      order_id: string;
      timestamp: number;
      webhook_type: 'status_update' | 'additional_payment_required' | 'post_billing';
      [claim: string]: unknown;
    }
  | {
      request_id: string;
      timestamp: number;
      webhook_type: 'digitization_results';
      [claim: string]: unknown;
    };

// ------------------------------------------------------------------ verification

export type WebhookVerificationFailure =
  | 'missing_signature'
  | 'malformed_signature'
  | 'unsupported_algorithm'
  | 'invalid_signature'
  | 'invalid_timestamp'
  | 'stale_timestamp'
  | 'id_mismatch'
  | 'invalid_payload';

/** Thrown by {@link verifyWebhookSignature}. Respond to the webhook with 401 and don't process it. */
export class WebhookVerificationError extends HlthstackBaseError {
  readonly reason: WebhookVerificationFailure;
  constructor(reason: WebhookVerificationFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface VerifyWebhookSignatureParams {
  /**
   * The request body: the raw body (string or bytes) or the already-parsed JSON object. The JWT
   * does not cover the body, so either works.
   */
  payload: string | Uint8Array | ArrayBuffer | object;
  /** The `Signature` request header. */
  signature: string | null | undefined;
  /** Your webhook secret (different for staging and production). */
  secret: string;
  /** Maximum allowed difference between now and the JWT `timestamp`. Default 300 (5 minutes). */
  toleranceSeconds?: number;
  /** Current time in Unix seconds. Defaults to `Date.now() / 1000`. */
  now?: number;
}

export interface VerifiedWebhook {
  claims: WebhookClaims;
  payload: WebhookPayload;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new Error('invalid base64url');
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function getSubtle(): Promise<SubtleCrypto> {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle;
  // Node 18 does not expose Web Crypto as a global.
  const nodeCrypto = await import('node:crypto');
  return nodeCrypto.webcrypto.subtle as unknown as SubtleCrypto;
}

function parsePayload(payload: VerifyWebhookSignatureParams['payload']): Record<string, unknown> {
  let value: unknown = payload;
  if (typeof payload === 'string' || payload instanceof Uint8Array || payload instanceof ArrayBuffer) {
    const text = typeof payload === 'string' ? payload : decoder.decode(payload);
    try {
      value = JSON.parse(text);
    } catch {
      throw new WebhookVerificationError('invalid_payload', 'Webhook body is not valid JSON');
    }
  }
  if (!isRecord(value)) throw new WebhookVerificationError('invalid_payload', 'Webhook body is not a JSON object');
  return value;
}

const present = (v: unknown): boolean => v !== undefined && v !== null;

/**
 * Verifies a webhook as described in the webhooks guide:
 *
 * 1. the `Signature` header is an HS256 JWT signed with your webhook secret (no other algorithm
 *    is accepted);
 * 2. the ids in the claims match the body: `order_id` and `webhook_type` = `type` for pharmacy,
 *    `request_id` for digitization, otherwise `appointment_id` and `booking_id`;
 * 3. the `timestamp` claim is within `toleranceSeconds` of now (replay protection).
 *
 * Resolves with the claims and the parsed body, or rejects with a {@link WebhookVerificationError}.
 */
export async function verifyWebhookSignature(
  params: VerifyWebhookSignatureParams,
): Promise<VerifiedWebhook> {
  const { signature, secret, toleranceSeconds = 300 } = params;
  if (!secret) throw new HlthstackBaseError('Webhook `secret` is required');
  if (!signature) throw new WebhookVerificationError('missing_signature', 'Missing Signature header');

  const parts = signature.trim().split('.');
  if (parts.length !== 3) {
    throw new WebhookVerificationError('malformed_signature', 'Signature is not a JWT');
  }
  const [headerB64, claimsB64, sigB64] = parts as [string, string, string];

  let header: unknown;
  let claims: unknown;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    header = JSON.parse(decoder.decode(base64UrlDecode(headerB64)));
    claims = JSON.parse(decoder.decode(base64UrlDecode(claimsB64)));
    sig = base64UrlDecode(sigB64);
  } catch {
    throw new WebhookVerificationError('malformed_signature', 'Signature is not a valid JWT');
  }
  if (!isRecord(header) || header.alg !== 'HS256') {
    throw new WebhookVerificationError('unsupported_algorithm', 'Signature must use HS256');
  }
  if (!isRecord(claims)) {
    throw new WebhookVerificationError('malformed_signature', 'JWT claims are not an object');
  }

  const subtle = await getSubtle();
  const key = await subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await subtle.verify('HMAC', key, sig, encoder.encode(`${headerB64}.${claimsB64}`));
  if (!valid) throw new WebhookVerificationError('invalid_signature', 'Invalid webhook signature');

  const { timestamp } = claims;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    throw new WebhookVerificationError('invalid_timestamp', 'JWT has no numeric timestamp claim');
  }
  const now = params.now ?? Date.now() / 1000;
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    throw new WebhookVerificationError('stale_timestamp', 'Webhook timestamp is outside the tolerance window');
  }

  const body = parsePayload(params.payload);
  let matches: boolean;
  if (present(claims.order_id)) {
    matches = claims.order_id === body.order_id && claims.webhook_type === body.type;
  } else if (present(claims.request_id)) {
    matches = claims.request_id === body.request_id;
  } else {
    matches =
      present(claims.appointment_id) &&
      claims.appointment_id === body.appointment_id &&
      claims.booking_id === body.booking_id;
  }
  if (!matches) {
    throw new WebhookVerificationError('id_mismatch', 'Webhook claims do not match the body');
  }

  return { claims: claims as WebhookClaims, payload: body as unknown as WebhookPayload };
}
