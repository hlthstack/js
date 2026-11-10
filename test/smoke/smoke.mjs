// Smoke test for the built package (ESM). Run after `npm run build`: node test/smoke/smoke.mjs
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { Hlthstack, HlthstackError, verifyWebhookSignature } from '../../dist/index.js';

const fetch = async (url) => {
  if (String(url).endsWith('/api/get-access-token')) {
    return Response.json({ access_token: 'smoke-token', expires_at: new Date(Date.now() + 3600e3).toISOString() });
  }
  if (String(url).includes('/api/providers')) return Response.json({ providers: [{ provider_id: 1001 }] });
  return new Response('HTTP Token: Access denied.', { status: 401 });
};

const client = new Hlthstack({ username: 'example-user', password: 'example-password', environment: 'staging', fetch });
const res = await client.appointments.listProviders({ service_name: 'ahc', package_ids: '1001', pincode: '500081' });
assert.equal(res.providers[0].provider_id, 1001);
await assert.rejects(client.appointments.cancel('APT1A2B3C4D5'), HlthstackError);

const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ order_id: 'EPO1', timestamp: now, webhook_type: 'status_update' })}`;
const signature = `${head}.${createHmac('sha256', 'example-secret').update(head).digest('base64url')}`;
const { payload } = await verifyWebhookSignature({
  payload: '{"type":"status_update","order_id":"EPO1"}',
  signature,
  secret: 'example-secret',
});
assert.equal(payload.order_id, 'EPO1');
console.log(`ESM smoke test passed on Node ${process.version}`);
