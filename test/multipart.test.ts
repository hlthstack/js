import { describe, expect, it } from 'vitest';
import { json, makeClient, mockFetch, route } from './helpers.js';

function setup() {
  const m = mockFetch(route({}, () => json({ ok: true }, 200)));
  return { ...m, client: makeClient(m.fetch), form: () => m.apiCalls().at(-1)!.body as FormData };
}

async function fileText(value: FormDataEntryValue | null): Promise<string> {
  if (!(value instanceof Blob)) throw new Error('expected a file');
  return value.text();
}

describe('multipart uploads', () => {
  it('consultations.uploadDocuments sends files[][name] + files[][value] pairs', async () => {
    const { client, form, apiCalls } = setup();
    await client.consultations.uploadDocuments('APT1A2B3C4D5', [
      { name: 'Blood report', file: new File(['pdf-bytes'], 'blood.pdf', { type: 'application/pdf' }) },
      { name: 'X-ray', file: { data: Buffer.from('png-bytes'), filename: 'xray.png' } },
    ]);
    const call = apiCalls()[0]!;
    expect(`${call.method} ${call.url.pathname}`).toBe('POST /api/consultations/APT1A2B3C4D5/upload_documents');
    // fetch must set the multipart boundary itself
    expect(call.headers.has('content-type')).toBe(false);

    const body = form();
    expect(body.getAll('files[][name]')).toEqual(['Blood report', 'X-ray']);
    const files = body.getAll('files[][value]') as File[];
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ['blood.pdf', 'application/pdf'],
      ['xray.png', 'image/png'],
    ]);
    expect(await fileText(files[0]!)).toBe('pdf-bytes');
    expect(await fileText(files[1]!)).toBe('png-bytes');
  });

  it('pharmacy.digitizePrescription sends customers[][...] fields, files[] and Idempotency-Key', async () => {
    const { client, form, apiCalls } = setup();
    await client.pharmacy.digitizePrescription(
      {
        customers: [
          {
            name: 'Jane Doe',
            api_customer_id: 'CUST1001',
            mobile_number: '9999999999',
            gender: 'female',
            dob: '1990-08-24',
          },
        ],
        plan_id: 'EXAMPLE_PLAN',
        files: [new Uint8Array([1, 2, 3]), new Blob(['jpg'], { type: 'image/jpeg' })],
      },
      { idempotencyKey: 'upload-0001' },
    );
    const call = apiCalls()[0]!;
    expect(`${call.method} ${call.url.pathname}`).toBe('POST /api/prescriptions/digitize');
    expect(call.headers.get('idempotency-key')).toBe('upload-0001');
    const body = form();
    expect(body.get('customers[][name]')).toBe('Jane Doe');
    expect(body.get('customers[][api_customer_id]')).toBe('CUST1001');
    expect(body.get('customers[][mobile_number]')).toBe('9999999999');
    expect(body.get('customers[][gender]')).toBe('female');
    expect(body.get('customers[][dob]')).toBe('1990-08-24');
    expect(body.get('plan_id')).toBe('EXAMPLE_PLAN');
    const files = body.getAll('files[]') as File[];
    expect(files).toHaveLength(2);
    expect(files[0]!.type).toBe('application/octet-stream');
    expect(new Uint8Array(await files[0]!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(files[1]!.type).toBe('image/jpeg');
  });

  it('pharmacy.updateCart switches to multipart for prescription_files', async () => {
    const { client, form, apiCalls } = setup();
    const bytes = new ArrayBuffer(4);
    await client.pharmacy.updateCart({
      customer_details: { api_customer_id: 'CUST1001' },
      plan_id: 'EXAMPLE_PLAN',
      prescription_files: [{ data: bytes, filename: 'rx.pdf' }],
    });
    const call = apiCalls()[0]!;
    expect(`${call.method} ${call.url.pathname}`).toBe('PATCH /api/epharmacy/cart');
    const body = form();
    expect(body.get('customer_details[api_customer_id]')).toBe('CUST1001');
    expect(body.get('plan_id')).toBe('EXAMPLE_PLAN');
    const [file] = body.getAll('prescription_files[]') as File[];
    expect(file?.name).toBe('rx.pdf');
    expect(file?.type).toBe('application/pdf');
    expect(file?.size).toBe(4);
  });
});
