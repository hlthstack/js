// Smoke test for the built package (CommonJS). Run after `npm run build`: node test/smoke/smoke.cjs
const assert = require('node:assert/strict');
const { Hlthstack, HlthstackError, verifyWebhookSignature, BASE_URLS } = require('../../dist/index.cjs');

assert.equal(typeof Hlthstack, 'function');
assert.equal(typeof HlthstackError, 'function');
assert.equal(typeof verifyWebhookSignature, 'function');
assert.equal(BASE_URLS.production, 'https://api.hlthstack.io');
const client = new Hlthstack({ username: 'example-user', password: 'example-password', environment: 'production', fetch: async () => new Response('{}') });
assert.equal(client.baseUrl, 'https://api.hlthstack.io');
console.log(`CJS smoke test passed on Node ${process.version}`);
