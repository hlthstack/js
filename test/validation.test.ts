import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { operations } from '../src/generated/validation.js';
import { HlthstackBaseError, HlthstackValidationError } from '../src/index.js';
import { validateRequest, type RequestInput, type ValidatedOperation } from '../src/validation.js';
import { json, makeClient, mockFetch, route } from './helpers.js';

/** The validator's clock in these tests: 10 Jan 2026, 12:00 IST. Spec examples are dated mid-January 2026. */
const NOW = new Date('2026-01-10T06:30:00Z');

function issues(operation: ValidatedOperation, input: RequestInput, now = NOW) {
  return validateRequest(operation, input, now);
}

/** `path rule` pairs, for compact assertions. */
function problems(operation: ValidatedOperation, input: RequestInput, now = NOW): string[] {
  return issues(operation, input, now).map((i) => `${i.path} ${i.rule}`);
}

// ------------------------------------------------------------------ spec examples

interface SpecOperation {
  operationId?: string;
  parameters?: Array<{ $ref?: string; name?: string; in?: string; example?: unknown }>;
  requestBody?: { content: Record<string, { example?: unknown; examples?: Record<string, { value: unknown }> }> };
}
const spec = yaml.load(readFileSync(new URL('../openapi/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, SpecOperation> & { parameters?: SpecOperation['parameters'] }>;
  components: { parameters: Record<string, { name: string; in: string; example?: unknown }> };
};

const specOperations = Object.values(spec.paths).flatMap((item) =>
  Object.values(item)
    .filter((op): op is SpecOperation => typeof op === 'object' && op !== null && 'operationId' in op)
    .map((op) => ({ op, shared: item.parameters ?? [] })),
);

function bodyExamples(): Array<[string, string, unknown]> {
  const out: Array<[string, string, unknown]> = [];
  for (const { op } of specOperations) {
    const content = op.requestBody?.content?.['application/json'];
    if (!content) continue;
    if (content.example !== undefined) out.push([op.operationId!, 'example', content.example]);
    for (const [name, ex] of Object.entries(content.examples ?? {})) out.push([op.operationId!, name, ex.value]);
  }
  return out;
}

function bodyExample(operation: string, name = 'example'): Record<string, unknown> {
  const found = bodyExamples().find(([op, n]) => op === operation && n === name);
  if (!found) throw new Error(`no ${name} for ${operation}`);
  return structuredClone(found[2]) as Record<string, unknown>;
}

function parameterExamples(): Array<[string, string, string, unknown]> {
  const out: Array<[string, string, string, unknown]> = [];
  for (const { op, shared } of specOperations) {
    for (const raw of [...shared, ...(op.parameters ?? [])]) {
      const p = raw.$ref ? spec.components.parameters[raw.$ref.split('/').pop()!]! : raw;
      if (p.example !== undefined && (p.in === 'query' || p.in === 'path')) {
        out.push([op.operationId!, p.in!, p.name!, p.example]);
      }
    }
  }
  return out;
}

describe('spec examples pass validation', () => {
  // Path parameters have no examples of their own here; use valid ids.
  const params = { booking_id: 'EKI0000000001700000000', appointment_id: 'APT1A2B3C4D5', order_id: 'EPO000000000001' };
  it.each(bodyExamples())('%s request body (%s)', (operation, _name, example) => {
    expect(issues(operation as ValidatedOperation, { params, body: example })).toEqual([]);
  });

  it.each(parameterExamples())('%s %s parameter %s', (operation, location, name, example) => {
    const input = location === 'path' ? { params: { [name]: example } } : { query: { [name]: example } };
    // Only this parameter is set, so ignore problems reported for the others.
    const own = issues(operation as ValidatedOperation, input).filter((i) => i.path === name && i.rule !== 'required_if');
    expect(own).toEqual([]);
  });
});

// ------------------------------------------------------------------ schema keywords

const customer = {
  name: 'Jane Doe',
  dob: '1990-08-24',
  mobile_number: '9999999999',
  api_customer_id: 'CUST1001',
  gender: 'female',
  package_ids: [1001],
};

describe('schema keywords', () => {
  it('required: reports every missing field with its path', () => {
    expect(
      problems('createAppointment', {
        body: { appointment_type: 'inclinic', service_name: 'ahc', customers: [{ name: 'Jane Doe' }] },
      }),
    ).toEqual([
      'provider_id required',
      'appointment_date_time required',
      'customers[0].api_customer_id required',
      'customers[0].mobile_number required',
      'customers[0].gender required',
      'customers[0].dob required',
      'customers[0].package_ids required',
    ]);
  });

  it('required: a missing request body', () => {
    expect(issues('createAppointment', {})).toEqual([
      { path: '', message: 'a request body is required', rule: 'required' },
    ]);
  });

  it('type, including type arrays and null', () => {
    const body = { ...bodyExample('createAppointment'), provider_id: true, customers: 'CUST1001' };
    expect(problems('createAppointment', { body })).toEqual(['provider_id type', 'customers type']);
    expect(issues('createAppointment', { body: { ...body, provider_id: '1001', customers: [customer] } })).toEqual([]);
    // [string, null]: null is fine for last_name, not for first_name (type string).
    const employee = { ...(bodyExample('createPreRegistrations').employees as object[])[0], last_name: null };
    expect(issues('createPreRegistrations', { body: { employees: [employee] } })).toEqual([]);
    expect(problems('createPreRegistrations', { body: { employees: [{ ...employee, first_name: null }] } })).toEqual([
      'employees[0].first_name type',
    ]);
  });

  it('type: query and multipart text fields accept numbers as their text', () => {
    expect(issues('listProviders', { query: { service_name: 'ahc', package_ids: 1001, pincode: 500081 } })).toEqual([]);
    expect(problems('listProviders', { query: { service_name: 'ahc', package_ids: '1001', pincode: 50008 } })).toEqual([
      'pincode pattern',
    ]);
  });

  it('type: query values that are undefined or null are not sent, so count as absent', () => {
    expect(
      issues('listProviders', { query: { service_name: 'ahc', package_ids: '1001', pincode: '500081', plan_id: null } }),
    ).toEqual([]);
  });

  it('enum', () => {
    const body = { ...bodyExample('createAppointment'), appointment_type: 'home' };
    expect(issues('createAppointment', { body })).toMatchObject([
      { path: 'appointment_type', rule: 'enum', message: 'must be one of "home_collection", "inclinic"' },
    ]);
  });

  it('pattern: anchored and unanchored, as the server matches them', () => {
    expect(problems('cancelAppointment', { params: { appointment_id: 'APT123' } })).toEqual(['appointment_id pattern']);
    // The server's own check is unanchored: surrounding characters pass.
    expect(issues('cancelAppointment', { params: { appointment_id: 'xAPT1A2B3C4D5x' } })).toEqual([]);
    const body = bodyExample('createAppointment');
    (body.customers as Array<Record<string, unknown>>)[0]!.api_customer_id = 'CUST-1001';
    expect(problems('createAppointment', { body })).toEqual(['customers[0].api_customer_id pattern']);
  });

  it('pattern: character classes for case-insensitive values, ^\\s*$ for blanks', () => {
    const query = { package_ids: '2001', pincode: '500081' };
    expect(issues('listInclinicConsultationProviders', { query: { ...query, gender: 'fEmAlE' } })).toEqual([]);
    expect(problems('listInclinicConsultationProviders', { query: { ...query, gender: 'F' } })).toEqual(['gender pattern']);
    const employee = (bodyExample('createPreRegistrations').employees as object[])[0];
    expect(issues('createPreRegistrations', { body: { employees: [{ ...employee, mobile_number: '  ' }] } })).toEqual([]);
    expect(problems('createPreRegistrations', { body: { employees: [{ ...employee, mobile_number: '99999' }] } })).toEqual([
      'employees[0].mobile_number pattern',
    ]);
  });

  it('minLength and maxLength', () => {
    expect(problems('searchMedicines', { query: { name: 'ab' } })).toEqual(['name minLength', 'name pattern']);
    expect(problems('searchMedicines', { query: { name: ' ab ' } })).toEqual(['name pattern']);
    expect(issues('searchMedicines', { query: { name: 'paracetamol' } })).toEqual([]);
    const body = bodyExample('createAppointment');
    (body.address as Record<string, unknown>).address_line_one = 'x'.repeat(255);
    expect(problems('createAppointment', { body })).toEqual(['address.address_line_one maxLength']);
  });

  it('minimum, maximum and exclusiveMinimum', () => {
    expect(problems('listProviders', { query: { service_name: 'ahc', package_ids: '1001', pincode: '500081', per_page: 51 } })).toEqual([
      'per_page maximum',
    ]);
    expect(problems('getCustomerWallet', { params: { company_slug: 'example-co' }, query: { customer_id: 'X', customer_plan_id: -1 } })).toEqual([
      'customer_plan_id minimum',
    ]);
    const body = bodyExample('createAppointment');
    (body.address as Record<string, unknown>).pincode = 99999; // integer pincodes: 100000-999999
    expect(problems('createAppointment', { body })).toEqual(['address.pincode minimum']);
    const confirm = { ...bodyExample('confirmOrder'), partner_collected_amount: 0 };
    expect(problems('confirmOrder', { params: { order_id: 'EPO000000000001' }, body: confirm })).toEqual([
      'partner_collected_amount exclusiveMinimum',
      'partner_collected_amount positive_decimal',
    ]);
  });

  it('minItems and maxItems', () => {
    expect(problems('createAppointment', { body: { ...bodyExample('createAppointment'), customers: [] } })).toEqual([
      'customers minItems',
    ]);
    const urls = Array.from({ length: 11 }, (_, i) => `https://files.example.com/${i}.pdf`);
    const cart = { ...bodyExample('updateCart', 'prescriptionUrl'), prescription_urls: urls };
    expect(problems('updateCart', { body: cart })).toEqual(['prescription_urls maxItems']);
  });

  it('format: date, date-time, uri and uuid', () => {
    const body = bodyExample('createAppointment');
    body.appointment_date_time = 'tomorrow';
    (body.customers as Array<Record<string, unknown>>)[0]!.dob = '1990-02-30';
    expect(problems('createAppointment', { body })).toEqual(['appointment_date_time format', 'customers[0].dob format']);
    // A date-time without an offset is accepted (the API reads it as IST).
    expect(issues('createAppointment', { body: { ...bodyExample('createAppointment'), appointment_date_time: '2026-01-15T08:00:00' } })).toEqual([]);
    const cart = { ...bodyExample('updateCart', 'prescriptionUrl'), prescription_urls: ['not a uri'] };
    expect(problems('updateCart', { body: cart })).toEqual(['prescription_urls[0] pattern', 'prescription_urls[0] format']);
    expect(problems('getPreRegistrationStatus', { params: { request_id: 'abc' } })).toEqual(['request_id format']);
    expect(issues('getPreRegistrationStatus', { params: { request_id: '3f2b8c1e-0d4a-4c5e-9b7a-2e6f1d8c9a01' } })).toEqual([]);
  });

  it('allOf: an in-clinic consultation address needs a pincode', () => {
    const body = bodyExample('createInclinicConsultation');
    delete (body.address as Record<string, unknown>).pincode;
    expect(problems('createInclinicConsultation', { body })).toEqual(['address.pincode required']);
    // The same address without a pincode is fine for a booking (it is derived from the coordinates).
    const booking = bodyExample('createAppointment');
    delete (booking.address as Record<string, unknown>).pincode;
    expect(issues('createAppointment', { body: booking })).toEqual([]);
  });

  it('oneOf and anyOf: voluntary plan entries', () => {
    const employee = (bodyExample('createPreRegistrations').employees as object[])[0];
    const withPlans = (plans: unknown[]) => ({ body: { employees: [{ ...employee, voluntary_plan_ids: plans }] } });
    expect(issues('createPreRegistrations', withPlans(['TOPUP', { plan_id: 'TOPUP', additional: 'TRUE' }, { plan_id: 'X', additional: 1 }]))).toEqual([]);
    expect(problems('createPreRegistrations', withPlans([5, { additional: true }, { plan_id: 'TOPUP', additional: 'yes' }, { plan_id: 'X', additional: 2 }]))).toEqual([
      'employees[0].voluntary_plan_ids[0] oneOf',
      'employees[0].voluntary_plan_ids[1].plan_id required',
      'employees[0].voluntary_plan_ids[2].additional pattern',
      'employees[0].voluntary_plan_ids[3].additional enum',
    ]);
  });

  it('file parts of multipart bodies', () => {
    const files = [new Blob(['%PDF'], { type: 'application/pdf' }), 'not-a-file'];
    expect(issues('digitizePrescription', { form: { customers: [customer], files } })).toMatchObject([
      { path: 'files[1]', rule: 'type' },
    ]);
  });
});

// ------------------------------------------------------------------ rule kinds

describe('x-hlthstack-rules', () => {
  it('required_if: a field required when another is not sent', () => {
    const query = { service_name: 'ahc', package_ids: '1001' };
    expect(issues('listProviders', { query })).toEqual([
      { path: 'latitude', rule: 'required_if', message: 'is required when pincode is not sent' },
      { path: 'longitude', rule: 'required_if', message: 'is required when pincode is not sent' },
    ]);
    expect(issues('listProviders', { query: { ...query, latitude: 17.44, longitude: 78.38 } })).toEqual([]);
    expect(issues('listProviders', { query: { ...query, pincode: '500081' } })).toEqual([]);
  });

  it('required_if: a field required when another has a value, and unless one is true', () => {
    expect(problems('getOrderPaymentDetails', { body: { ...bodyExample('getOrderPaymentDetails'), selected_delivery_option: 'store_pickup' } })).toEqual([
      'selected_chemist_id required_if',
    ]);
    const specialist = bodyExample('createSpecialistConsultation');
    delete specialist.appointment_date_time;
    expect(problems('createSpecialistConsultation', { body: specialist })).toEqual(['appointment_date_time required_if']);
    expect(issues('createSpecialistConsultation', { body: { ...specialist, priority_consultation: true } })).toEqual([]);
  });

  it('allowed_only_if', () => {
    const query = { service_name: 'ahc', package_ids: '1001', pincode: '500081' };
    expect(issues('listProviders', { query: { ...query, sort_by: 'fee', gender: 'Male' } })).toEqual([
      { path: 'sort_by', rule: 'allowed_only_if', message: 'is accepted only when service_name is inclinic_consultation' },
      { path: 'gender', rule: 'allowed_only_if', message: 'is accepted only when service_name is inclinic_consultation' },
    ]);
    expect(issues('listProviders', { query: { ...query, service_name: 'inclinic_consultation', sort_by: 'fee', gender: 'Male' } })).toEqual([]);
  });

  it('at_least_one_of: at the top level, per array item, and inside an optional object', () => {
    expect(issues('listCustomerAppointments', { query: { status: 'confirmed' } })).toEqual([
      { path: '', rule: 'at_least_one_of', message: 'send at least one of api_customer_id, employee_id' },
    ]);
    expect(problems('createPreRegistrations', { body: { employees: [], dependants: [{ first_name: 'John', last_name: 'Doe', date_of_birth: '', gender: '', mobile_number: '', relation: '', guardian_email: ' ' }] } })).toEqual([
      'dependants[0] at_least_one_of',
    ]);
    const cart = bodyExample('updateCart', 'address');
    delete (cart.address as Record<string, unknown>).pincode;
    expect(problems('updateCart', { body: cart })).toEqual(['address at_least_one_of']);
    expect(issues('updateCart', { body: { ...cart, address: { ...(cart.address as object), zip_code: '380005' } } })).toEqual([]);
  });

  it('at_least_one_of with groups: every field of one group must be sent', () => {
    const dependant = { first_name: 'John', last_name: 'Doe', date_of_birth: '', gender: '', mobile_number: '', relation: '' };
    const create = (extra: Record<string, unknown>) =>
      issues('createPreRegistrations', { body: { employees: [], dependants: [{ ...dependant, ...extra }] } })
        .filter((i) => i.rule === 'at_least_one_of');
    expect(create({ guardian_employee_code: 'EMP1001' })).toEqual([
      {
        path: 'dependants[0]',
        rule: 'at_least_one_of',
        message: 'send at least one of guardian_email, company_id with guardian_employee_code',
      },
    ]);
    expect(create({ company_id: 1001, guardian_employee_code: 'EMP1001' })).toEqual([]);
    expect(create({ guardian_email: 'jane@example.com' })).toEqual([]);
    const update = (employee: Record<string, unknown>) =>
      problems('updatePreRegistrations', { body: { employees: [employee] } }).filter((p) => p.endsWith('at_least_one_of'));
    expect(update({ employee_code: 'EMP1001' })).toEqual(['employees[0] at_least_one_of']);
    expect(update({ company_id: 1001, employee_code: 'EMP1001' })).toEqual([]);
  });

  it('mutually_exclusive', () => {
    const cart = { ...bodyExample('updateCart', 'address'), address_id: 12 };
    expect(issues('updateCart', { body: cart })).toEqual([
      { path: '', rule: 'mutually_exclusive', message: 'send only one of address, address_id' },
    ]);
  });

  it('unique_by', () => {
    const body = bodyExample('createAppointment');
    body.customers = [customer, { ...customer, name: 'John Doe' }];
    expect(issues('createAppointment', { body })).toEqual([
      {
        path: 'customers[1].api_customer_id',
        rule: 'unique_by',
        message: 'duplicates customers[0].api_customer_id ("CUST1001")',
      },
    ]);
    const cart = { ...bodyExample('updateCart', 'products'), products: [{ id: 50001, quantity: 1 }, { id: 50001, quantity: 2 }] };
    expect(problems('updateCart', { body: cart })).toEqual(['products[1].id unique_by']);
  });

  it('relative_date: at least one year old, on the API calendar (IST), with an injectable clock', () => {
    const body = (dob: string) => {
      const b = bodyExample('createAppointment');
      (b.customers as Array<Record<string, unknown>>)[0]!.dob = dob;
      return { body: b };
    };
    // 10 Jan 2026 12:00 IST: the latest accepted dob is 2025-01-10.
    expect(issues('createAppointment', body('2025-01-10'))).toEqual([]);
    expect(issues('createAppointment', body('2025-01-11'))).toEqual([
      { path: 'customers[0].dob', rule: 'relative_date', message: 'must be on or before 2025-01-10 (at least 1 year(s) ago)' },
    ]);
    // 9 Jan 2026 20:00 UTC is already 10 Jan in IST.
    expect(issues('createAppointment', body('2025-01-10'), new Date('2026-01-09T20:00:00Z'))).toEqual([]);
    expect(problems('createAppointment', body('2025-01-10'), new Date('2026-01-09T18:00:00Z'))).toEqual([
      'customers[0].dob relative_date',
    ]);
    // 29 Feb falls back to 28 Feb a year later.
    expect(issues('createAppointment', body('2027-02-28'), new Date('2028-02-29T06:30:00Z'))).toEqual([]);
  });

  it('relative_date: not after today, in any accepted date format, skipping blanks', () => {
    const employee = (bodyExample('createPreRegistrations').employees as object[])[0];
    const rows = (date_of_birth: string) => ({ body: { employees: [{ ...employee, date_of_birth }] } });
    expect(issues('createPreRegistrations', rows('10-01-2026'))).toEqual([]);
    expect(issues('createPreRegistrations', rows(''))).toEqual([]);
    expect(issues('createPreRegistrations', rows('11/01/2026'))).toEqual([
      { path: 'employees[0].date_of_birth', rule: 'relative_date', message: 'must not be after today (2026-01-10)' },
    ]);
    const form = { customers: [{ ...customer, dob: '2026-01-11' }], files: [new Blob(['x'], { type: 'image/png' })] };
    expect(problems('digitizePrescription', { form })).toEqual(['customers[0].dob relative_date']);
  });

  it('relative_date: later than now, reading a time without an offset as IST', () => {
    const at = (appointment_date_time: string) => ({ params: { appointment_id: 'APT1A2B3C4D5' }, body: { appointment_date_time } });
    expect(issues('rescheduleConsultation', at('2026-01-10T06:31:00Z'))).toEqual([]);
    expect(problems('rescheduleConsultation', at('2026-01-10T06:30:00Z'))).toEqual(['appointment_date_time relative_date']);
    // 12:15 IST is 06:45 UTC: later than now. Read as UTC it would be in the future too, so use 11:45.
    expect(issues('rescheduleConsultation', at('2026-01-10T12:15:00'))).toEqual([]);
    expect(issues('rescheduleConsultation', at('2026-01-10T11:45:00'))).toEqual([
      {
        path: 'appointment_date_time',
        rule: 'relative_date',
        message: 'must be later than now (2026-01-10T06:30:00.000Z); without an offset it is read as +05:30',
      },
    ]);
    expect(issues('rescheduleConsultation', at('2026-01-10T12:15:00+0530'))).toEqual([]);
    // Unless priority_consultation is true.
    const specialist = { ...bodyExample('createSpecialistConsultation'), appointment_date_time: '2026-01-01T04:30:00Z' };
    expect(problems('createSpecialistConsultation', { body: specialist })).toEqual(['appointment_date_time relative_date']);
    expect(issues('createSpecialistConsultation', { body: { ...specialist, priority_consultation: true } })).toEqual([]);
  });

  it('no_conflicting_pincode', () => {
    const booking = (address: Record<string, unknown>, appointment_type = 'home_collection') => {
      const body = bodyExample('createAppointment');
      return { body: { ...body, appointment_type, address: { ...(body.address as object), ...address } } };
    };
    expect(issues('createAppointment', booking({ address_line_two: 'Madhapur 500081' }))).toEqual([]);
    expect(issues('createAppointment', booking({ city: 'Hyderabad 500032' }))).toEqual([
      {
        path: 'address.city',
        rule: 'no_conflicting_pincode',
        message: 'contains the pincode 500032, which differs from the address pincode 500081',
      },
    ]);
    // Other countries and longer numbers are not checked.
    expect(issues('createAppointment', booking({ country: 'Nepal', city: 'Kathmandu 446600' }))).toEqual([]);
    expect(issues('createAppointment', booking({ address_line_one: 'Plot 5000321' }))).toEqual([]);
    // createAppointment checks it for home collection only.
    expect(issues('createAppointment', booking({ city: 'Hyderabad 500032' }, 'inclinic'))).toEqual([]);
    // A cart address has no country (blank counts as India), and may carry the pincode as zip_code.
    const cart = bodyExample('updateCart', 'address');
    expect(problems('updateCart', { body: { ...cart, address: { ...(cart.address as object), line1: 'Road 380001' } } })).toEqual([
      'address.line1 no_conflicting_pincode',
    ]);
    cart.address = { ...(cart.address as object), pincode: undefined, zip_code: '380005', line2: 'Motera 380005' };
    expect(issues('updateCart', { body: cart })).toEqual([]);
  });

  it('file_limits: size, content type and extension', () => {
    const big = { data: new Uint8Array(10 * 1024 * 1024 + 1), filename: 'rx.pdf' };
    const form = { customers: [customer], files: [big, { data: new Uint8Array(1), filename: 'rx.gif' }] };
    expect(issues('digitizePrescription', { form })).toEqual([
      { path: 'files[0]', rule: 'file_limits', message: 'is 10485761 bytes; at most 10485760 bytes are accepted' },
      {
        path: 'files[1]',
        rule: 'file_limits',
        message: 'must be image/jpeg, image/png, application/pdf (got no content type; pass a filename or contentType)',
      },
    ]);
    // updateCart: smaller than 7 MB.
    const cart = (size: number) => ({
      form: { customer_details: { api_customer_id: 'CUST1001' }, prescription_files: [new Blob([new Uint8Array(size)], { type: 'image/png' })] },
    });
    expect(issues('updateCart', cart(7 * 1024 * 1024 - 1))).toEqual([]);
    expect(problems('updateCart', cart(7 * 1024 * 1024))).toEqual(['prescription_files[0] file_limits']);
    // uploadConsultationDocuments: by extension.
    const docs = (filename: string) => ({
      params: { appointment_id: 'APT1A2B3C4D5' },
      form: { files: [{ name: 'Report', value: { data: new Uint8Array(1), filename } }] },
    });
    expect(issues('uploadConsultationDocuments', docs('report.JPG'))).toEqual([]);
    expect(issues('uploadConsultationDocuments', docs('report.docx'))).toEqual([
      { path: 'files[0].value', rule: 'file_limits', message: 'needs a filename ending in .pdf, .jpg, .jpeg, .png (got "report.docx")' },
    ]);
  });

  it('item_count', () => {
    const file = new Blob(['x'], { type: 'image/png' });
    expect(problems('digitizePrescription', { form: { customers: [customer, { ...customer, api_customer_id: 'CUST1002' }], files: [file] } })).toEqual([
      'customers item_count',
    ]);
    expect(problems('digitizePrescription', { form: { customers: [customer], files: [] } })).toEqual(['files minItems', 'files item_count']);
    expect(problems('uploadConsultationDocuments', { params: { appointment_id: 'APT1A2B3C4D5' }, form: { files: [] } })).toEqual([
      'files item_count',
    ]);
    const emails = (n: number) => Array.from({ length: n }, (_, i) => `member${i}@example.com`);
    expect(issues('deactivatePreRegistrations', { body: { employees: emails(200), dependants: emails(50) } })).toEqual([]);
    expect(issues('deactivatePreRegistrations', { body: { employees: emails(200), dependants: emails(51) } })).toEqual([
      { path: '', rule: 'item_count', message: 'employees and dependants must have at most 250 item(s) together, got 251' },
    ]);
  });

  it('positive_decimal', () => {
    const confirm = (amount: unknown) => ({
      params: { order_id: 'EPO000000000001' },
      body: { ...bodyExample('confirmOrder'), partner_collected_amount: amount },
    });
    for (const ok of ['261.0', ' 261 ', '.5', 261.5]) expect(issues('confirmOrder', confirm(ok))).toEqual([]);
    for (const bad of ['0', '-1', '0.00', 'abc', '1e3', '']) {
      expect(problems('confirmOrder', confirm(bad))).toEqual(['partner_collected_amount positive_decimal']);
    }
  });
});

// ------------------------------------------------------------------ one valid and one invalid case per operation with rules

const file = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
const appointmentId = { appointment_id: 'APT1A2B3C4D5' };
const bookingId = { booking_id: 'EKI0000000001700000000' };

const cases: Record<string, { valid: RequestInput; invalid: RequestInput; expected: string[] }> = {
  listProviders: {
    valid: { query: { service_name: 'ahc', package_ids: '1001,1002', pincode: '500081' } },
    invalid: { query: { service_name: 'ahc', package_ids: '1001', sort_by: 'visited_before', latitude: 17.4 } },
    expected: ['longitude required_if', 'sort_by allowed_only_if', 'api_customer_id required_if'],
  },
  createAppointment: {
    valid: { body: bodyExample('createAppointment') },
    invalid: { body: { ...bodyExample('createAppointment'), address: undefined } },
    expected: ['address required_if'],
  },
  listCustomerAppointments: {
    valid: { query: { employee_id: 'EMP1001' } },
    invalid: { query: { api_customer_id: ' ' } },
    expected: [' at_least_one_of'],
  },
  rescheduleBooking: {
    valid: { params: bookingId, body: bodyExample('rescheduleBooking') },
    invalid: { params: bookingId, body: { appointment_date_time: '2026-01-16T02:30:00Z', address: { ...(bodyExample('createAppointment').address as object), address_line_one: 'Road 560001' } } },
    expected: ['address.address_line_one no_conflicting_pincode'],
  },
  rescheduleAppointment: {
    valid: { params: appointmentId, body: bodyExample('rescheduleAppointment') },
    invalid: { params: appointmentId, body: { appointment_date_time: '2026-01-16T02:30:00Z', address: { ...(bodyExample('createAppointment').address as object), state: 'Telangana 500001' } } },
    expected: ['address.state no_conflicting_pincode'],
  },
  listInclinicConsultationProviders: {
    valid: { query: { package_ids: '2001', latitude: 17.44, longitude: 78.38, sort_by: 'visited_before', api_customer_id: 'CUST1001' } },
    invalid: { query: { package_ids: '2001', sort_by: 'visited_before' } },
    expected: ['latitude required_if', 'longitude required_if', 'api_customer_id required_if'],
  },
  createInclinicConsultation: {
    valid: { body: bodyExample('createInclinicConsultation') },
    invalid: { body: { ...bodyExample('createInclinicConsultation'), appointment_date_time: '2026-01-09T04:30:00Z', customers: [customer, customer] } },
    expected: ['customers[1].api_customer_id unique_by', 'appointment_date_time relative_date'],
  },
  createSpecialistConsultation: {
    valid: { body: bodyExample('createSpecialistConsultation') },
    invalid: { body: { ...bodyExample('createSpecialistConsultation'), customers: [{ ...customer, dob: '2025-06-01' }] } },
    expected: ['customers[0].dob relative_date'],
  },
  rescheduleConsultation: {
    valid: { params: appointmentId, body: bodyExample('rescheduleConsultation') },
    invalid: { params: appointmentId, body: { appointment_date_time: '2025-12-31T10:00:00Z' } },
    expected: ['appointment_date_time relative_date'],
  },
  uploadConsultationDocuments: {
    valid: { params: appointmentId, form: { files: [{ name: 'Blood report', value: { data: file, filename: 'blood.pdf' } }] } },
    invalid: { params: appointmentId, form: { files: [{ name: ' ', value: { data: file, filename: 'blood' } }] } },
    expected: ['files[0].name pattern', 'files[0].value file_limits'],
  },
  digitizePrescription: {
    valid: { form: { customers: [{ ...customer, package_ids: undefined }], plan_id: 'EXAMPLE_PLAN', files: [file] } },
    invalid: { form: { customers: [], files: [new Uint8Array(3)] } },
    expected: ['customers item_count', 'files[0] file_limits'],
  },
  updateCart: {
    valid: { body: bodyExample('updateCart', 'products') },
    invalid: { body: { plan_id: 'EXAMPLE_PLAN', customer_details: { api_customer_id: 'CUST1001' }, fulfillment_type: 'store_pickup' } },
    expected: ['selected_chemist_id required_if'],
  },
  getOrderPaymentDetails: {
    valid: { body: bodyExample('getOrderPaymentDetails') },
    invalid: { body: { ...bodyExample('getOrderPaymentDetails'), selected_delivery_option: 'store_pickup' } },
    expected: ['selected_chemist_id required_if'],
  },
  confirmOrder: {
    valid: { params: { order_id: 'EPO000000000003' }, body: bodyExample('confirmOrder') },
    invalid: { params: { order_id: 'EPO000000000003' }, body: { ...bodyExample('confirmOrder'), partner_collected_amount: '-5' } },
    expected: ['partner_collected_amount positive_decimal'],
  },
  getCustomerWallet: {
    valid: { params: { company_slug: 'example-co' }, query: { api_customer_id: 'CUST1001' } },
    invalid: { params: { company_slug: 'example-co' }, query: { plan_id: 'EXAMPLE_PLAN' } },
    expected: [' at_least_one_of'],
  },
  listCustomerPlans: {
    valid: { params: { company_slug: 'example-co' }, query: { customer_id: 'EKI000000001' } },
    invalid: { params: { company_slug: 'example-co' }, query: {} },
    expected: [' at_least_one_of'],
  },
  createPreRegistrations: {
    valid: { body: bodyExample('createPreRegistrations') },
    invalid: {
      body: {
        employees: [{ ...(bodyExample('createPreRegistrations').employees as object[])[0], email: '', employee_code: null }],
      },
    },
    expected: ['employees[0] at_least_one_of'],
  },
  updatePreRegistrations: {
    valid: { body: bodyExample('updatePreRegistrations') },
    invalid: { body: { dependants: [{ last_name: 'Doe' }] } },
    expected: ['dependants[0] at_least_one_of'],
  },
  deactivatePreRegistrations: {
    valid: { body: bodyExample('deactivatePreRegistrations') },
    invalid: { body: { employees: Array.from({ length: 251 }, (_, i) => `m${i}@example.com`) } },
    expected: [' item_count'],
  },
};

describe('every operation with rules', () => {
  const withRules = Object.entries(operations)
    .filter(([, op]) => 'rules' in op)
    .map(([id]) => id);

  it('has a case here', () => {
    expect(Object.keys(cases).sort()).toEqual(withRules.sort());
  });

  it.each(Object.entries(cases))('%s', (operation, { valid, invalid, expected }) => {
    expect(issues(operation as ValidatedOperation, valid)).toEqual([]);
    expect(problems(operation as ValidatedOperation, invalid)).toEqual(expected);
  });
});

// ------------------------------------------------------------------ the client

describe('client', () => {
  function setup(options: Parameters<typeof makeClient>[1] = {}) {
    const m = mockFetch(route({}, () => json({})));
    return { ...m, client: makeClient(m.fetch, { preRegistrationUsername: 'pre', preRegistrationPassword: 'pw', ...options }) };
  }

  it('throws HlthstackValidationError before fetching a token or calling the API', async () => {
    const { client, calls } = setup();
    const error = await client.appointments
      .create({ ...bodyExample('createAppointment'), customers: [{ ...customer, gender: 'f' }, customer] } as never)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HlthstackValidationError);
    expect(error).toBeInstanceOf(HlthstackBaseError);
    expect((error as HlthstackValidationError).operation).toBe('createAppointment');
    expect((error as HlthstackValidationError).errors).toEqual([
      { path: 'customers[0].gender', message: 'must be one of "male", "female", "non-binary"', rule: 'enum' },
      { path: 'customers[1].api_customer_id', message: 'duplicates customers[0].api_customer_id ("CUST1001")', rule: 'unique_by' },
    ]);
    expect((error as Error).message).toBe(
      'Invalid createAppointment request (2 problems): customers[0].gender: must be one of "male", "female", "non-binary"; ' +
        'customers[1].api_customer_id: duplicates customers[0].api_customer_id ("CUST1001")',
    );
    expect(calls).toHaveLength(0);
  });

  it('validates path parameters, multipart uploads and pre-registration calls', async () => {
    const { client, calls } = setup();
    await expect(client.appointments.getVoucher('not-an-id')).rejects.toThrow('appointment_id: must match APT[0-9A-Z_]{9}');
    await expect(
      client.consultations.uploadDocuments('APT1A2B3C4D5', [{ name: 'Report', file: new Uint8Array(1) }]),
    ).rejects.toThrow('documents[0].file: needs a filename ending in .pdf, .jpg, .jpeg, .png (got "file")');
    await expect(
      client.pharmacy.updateCart({ customer_details: { api_customer_id: ' ' }, prescription_files: [file] }),
    ).rejects.toThrow('customer_details.api_customer_id: must match \\S');
    await expect(client.preRegistration.deactivate({ employees: [] as string[], dependants: Array(251).fill('9999999999') })).rejects.toThrow(
      HlthstackValidationError,
    );
    await expect(client.preRegistration.getStatus('abc')).rejects.toThrow('request_id: must be a UUID');
    expect(calls).toHaveLength(0);
  });

  it('can be turned off for the client or for one call', async () => {
    const off = setup({ validate: false });
    await off.client.appointments.getVoucher('not-an-id');
    expect(off.apiCalls()).toHaveLength(1);

    const { client, apiCalls } = setup();
    await client.appointments.cancel('not-an-id', { validate: false });
    await client.pharmacy.digitizePrescription({ customers: [customer as never], files: [new Uint8Array(1)] }, { validate: false });
    expect(apiCalls().map((c) => c.url.pathname)).toEqual(['/api/appointments/not-an-id/cancel', '/api/prescriptions/digitize']);
    await expect(client.appointments.cancel('not-an-id', { validate: true })).rejects.toThrow(HlthstackValidationError);
  });
});
