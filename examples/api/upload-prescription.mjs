// Prescription digitization (multipart upload) with plain fetch.
//   HLTHSTACK_USERNAME=... HLTHSTACK_PASSWORD=... node examples/api/upload-prescription.mjs rx.jpg
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { api } from './client.mjs';

const file = process.env.PRESCRIPTION_FILE ?? process.argv[2];
if (!file) throw new Error('Usage: node examples/api/upload-prescription.mjs <prescription.pdf|jpg|png>');
const type = { '.pdf': 'application/pdf', '.png': 'image/png' }[file.slice(file.lastIndexOf('.')).toLowerCase()] ?? 'image/jpeg';

// Exactly one customer, bracketed field names as the spec defines them; JPEG, PNG or PDF up to 10 MB.
const form = new FormData();
form.append('customers[][name]', 'Jane Doe');
form.append('customers[][api_customer_id]', 'CUST1001');
form.append('customers[][mobile_number]', '9999999999');
form.append('customers[][gender]', 'female');
form.append('customers[][dob]', '1990-08-24');
form.append('files[]', new Blob([await readFile(file)], { type }), basename(file));

// An Idempotency-Key makes a retry return the original request instead of a duplicate.
const accepted = await api('POST', '/api/prescriptions/digitize', {
  form,
  headers: { 'Idempotency-Key': randomUUID() },
});
console.log('Accepted', accepted.request_id, accepted.status);

// Poll (or wait for the digitization_results webhook) until it finishes.
const done = ['completed', 'partial', 'rejected', 'failed'];
let result = await api('GET', `/api/prescriptions/digitize/${accepted.request_id}`);
while (!done.includes(result.status)) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  result = await api('GET', `/api/prescriptions/digitize/${accepted.request_id}`);
}
console.log(result.status, result.items, 'cart_id:', result.cart_id);
