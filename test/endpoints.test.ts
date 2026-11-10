import { describe, expect, it } from 'vitest';
import { HlthstackBaseError } from '../src/index.js';
import { json, jsonBody, makeClient, mockFetch, route } from './helpers.js';

function setup(routes: Parameters<typeof route>[0] = {}, environment: 'staging' | 'production' = 'staging') {
  const m = mockFetch(route(routes));
  return { ...m, client: makeClient(m.fetch, { environment }), last: () => m.apiCalls().at(-1)! };
}

const customer = {
  name: 'Jane Doe',
  dob: '1990-08-24',
  mobile_number: '9999999999',
  api_customer_id: 'CUST1001',
  gender: 'female' as const,
  package_ids: [1001],
};

const address = {
  address_line_one: '1 Example Road',
  address_line_two: 'Madhapur',
  city: 'Hyderabad',
  state: 'Telangana',
  country: 'India',
  pincode: '500081',
  latitude: 17.4437,
  longitude: 78.386,
};

describe('appointments', () => {
  it('listProviders sends query params', async () => {
    const { client, last } = setup({ 'GET /api/providers': () => json({ providers: [] }) });
    const res = await client.appointments.listProviders({
      service_name: 'ahc',
      package_ids: '1001,1002',
      latitude: 17.4437,
      longitude: 78.386,
      auto_allocate_provider: true,
      plan_id: undefined,
    });
    expect(res).toEqual({ providers: [] });
    const call = last();
    expect(call.method).toBe('GET');
    expect(call.url.origin + call.url.pathname).toBe('https://staging-api.hlthstack.io/api/providers');
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      service_name: 'ahc',
      package_ids: '1001,1002',
      latitude: '17.4437',
      longitude: '78.386',
      auto_allocate_provider: 'true',
    });
    expect(call.body).toBeUndefined();
  });

  it('listSlots builds the path', async () => {
    const { client, last } = setup();
    await client.appointments.listSlots(1001, 'ahc', { package_ids: '1001', booking_date: '2026-01-15' });
    expect(last().url.pathname).toBe('/api/providers/1001/ahc/slots');
    expect(last().url.search).toBe('?package_ids=1001&booking_date=2026-01-15');
  });

  it('create posts JSON', async () => {
    const response = { provider_id: 1001, booking_id: 'EKI0000000001700000000', status: 'confirmed', customers: [] };
    const { client, last } = setup({ 'POST /api/appointments': () => json(response) });
    const params = {
      appointment_date_time: '2026-01-15T02:30:00Z',
      appointment_type: 'home_collection' as const,
      service_name: 'ahc',
      provider_id: 1001,
      customers: [{ ...customer, booking_customer: true }],
      address,
    };
    expect(await client.appointments.create(params)).toEqual(response);
    expect(last().method).toBe('POST');
    expect(last().headers.get('content-type')).toBe('application/json');
    expect(await jsonBody(last())).toEqual(params);
  });

  it('get, reschedule, cancel and booking-level calls', async () => {
    const { client, apiCalls } = setup();
    await client.appointments.get({ booking_id: 'EKI0000000001700000000', appointment_id: 'APT1A2B3C4D5' });
    await client.appointments.reschedule('APT1A2B3C4D5', { appointment_date_time: '2026-01-16T02:30:00Z' });
    await client.appointments.cancel('APT1A2B3C4D5');
    await client.appointments.rescheduleBooking('EKI0000000001700000000', {
      appointment_date_time: '2026-01-16T02:30:00Z',
    });
    await client.appointments.cancelBooking('EKI0000000001700000000');
    await client.appointments.listForCustomer({ api_customer_id: 'CUST1001', status: 'confirmed' });
    await client.appointments.getPaymentDetails({
      provider_id: 1001,
      appointment_type: 'inclinic',
      service_name: 'ahc',
      customers: [{ api_customer_id: 'CUST1001', package_ids: [1001] }],
    });
    await client.appointments.getReports('APT1A2B3C4D5');
    await client.appointments.getLabResults('APT1A2B3C4D5');
    expect(apiCalls().map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      'GET /api/appointments?booking_id=EKI0000000001700000000&appointment_id=APT1A2B3C4D5',
      'PATCH /api/appointments/APT1A2B3C4D5/reschedule',
      'PATCH /api/appointments/APT1A2B3C4D5/cancel',
      'PATCH /api/bookings/EKI0000000001700000000/reschedule',
      'PATCH /api/bookings/EKI0000000001700000000/cancel',
      'GET /api/appointments/customer_appointments?api_customer_id=CUST1001&status=confirmed',
      'POST /api/appointments/payment_details',
      'GET /api/appointments/APT1A2B3C4D5/reports',
      'GET /api/appointments/APT1A2B3C4D5/lab_results',
    ]);
    expect(apiCalls()[2]?.body).toBeUndefined();
  });

  it('getVoucher returns the PDF bytes', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4 example');
    const { client, last } = setup({
      'GET /api/appointments/APT1A2B3C4D5/voucher': () =>
        new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } }),
    });
    const voucher = await client.appointments.getVoucher('APT1A2B3C4D5');
    expect(voucher).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(voucher)).toBe('%PDF-1.4 example');
    expect(last().headers.get('accept')).toContain('application/pdf');
  });

  it('encodes path parameters', async () => {
    const { client, last } = setup();
    await client.appointments.cancel('APT/../x?y');
    expect(last().url.pathname).toBe('/api/appointments/APT%2F..%2Fx%3Fy/cancel');
  });
});

describe('consultations', () => {
  it('createInclinic and createSpecialist', async () => {
    const { client, apiCalls } = setup();
    const inclinic = {
      appointment_date_time: '2026-01-15T04:30:00.000Z',
      service_mode: 'at_provider_location' as const,
      provider_id: 2001,
      customers: [customer],
      address,
    };
    const specialist = {
      service_mode: 'audio_call' as const,
      provider_id: 3001,
      priority_consultation: true,
      customers: [customer],
    };
    await client.consultations.createInclinic(inclinic);
    await client.consultations.createSpecialist(specialist);
    const [a, b] = apiCalls();
    expect(`${a?.method} ${a?.url.pathname}`).toBe('POST /api/consultations/inclinic_consultation');
    expect(await jsonBody(a)).toEqual(inclinic);
    expect(`${b?.method} ${b?.url.pathname}`).toBe('POST /api/consultations/specialist_consultation');
    expect(await jsonBody(b)).toEqual(specialist);
  });

  it('provider lists, details, reschedule and cancel', async () => {
    const { client, apiCalls } = setup({
      'PATCH /api/consultations/APT1A2B3C4D5/cancel': () => json({ msg: 'Appointment cancelled' }),
    });
    await client.consultations.listInclinicProviders({
      package_ids: '2001',
      pincode: '500081',
      sort_by: 'fee',
      gender: 'Female',
    });
    await client.consultations.listSpecialistProviders({ package_ids: '3001', default_provider: true });
    await client.consultations.listSlots(3001, 'specialist_consultation', { package_ids: '3001' });
    await client.consultations.getInclinic('APT1A2B3C4D5');
    await client.consultations.getSpecialist('APT1A2B3C4D5');
    await client.consultations.reschedule('APT1A2B3C4D5', { appointment_date_time: '2026-01-16T04:30:00.000Z' });
    const cancelled = await client.consultations.cancel('APT1A2B3C4D5');
    await client.consultations.getSummaryAndPrescription('APT1A2B3C4D5');
    expect(cancelled.msg).toBe('Appointment cancelled');
    expect(apiCalls().map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      'GET /api/consultations/inclinic_consultation/providers?package_ids=2001&pincode=500081&sort_by=fee&gender=Female',
      'GET /api/consultations/specialist_consultation/providers?package_ids=3001&default_provider=true',
      'GET /api/providers/3001/specialist_consultation/slots?package_ids=3001',
      'GET /api/consultations/inclinic_consultation/APT1A2B3C4D5',
      'GET /api/consultations/specialist_consultation/APT1A2B3C4D5',
      'PATCH /api/consultations/APT1A2B3C4D5/reschedule',
      'PATCH /api/consultations/APT1A2B3C4D5/cancel',
      'GET /api/consultations/APT1A2B3C4D5/summary_and_prescription',
    ]);
    expect(await jsonBody(apiCalls()[5])).toEqual({ appointment_date_time: '2026-01-16T04:30:00.000Z' });
  });

  it('getVoucher returns bytes', async () => {
    const { client, last } = setup({
      'GET /api/consultations/APT1A2B3C4D5/voucher': () => new Response(new Uint8Array([37, 80, 68, 70])),
    });
    const voucher = await client.consultations.getVoucher('APT1A2B3C4D5');
    expect(new Uint8Array(voucher)).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(last().url.pathname).toBe('/api/consultations/APT1A2B3C4D5/voucher');
  });
});

describe('pharmacy', () => {
  it('searchMedicines', async () => {
    const { client, last } = setup();
    await client.pharmacy.searchMedicines({ name: 'paracetamol', page: 2 });
    expect(`${last().method} ${last().url.pathname}${last().url.search}`).toBe(
      'GET /api/epharmacy/medicines/search?name=paracetamol&page=2',
    );
  });

  it('serialises customer_details in the query string', async () => {
    const { client, apiCalls } = setup();
    await client.pharmacy.getCart({ customer_details: { api_customer_id: 'CUST1001' }, plan_id: 'EXAMPLE_PLAN' });
    await client.pharmacy.getFulfillmentOptions({ customer_details: { api_customer_id: 'CUST1001' }, cart_id: 701 });
    await client.pharmacy.listOrders({ customer_details: { api_customer_id: 'CUST1001' }, page: 1, per_page: 10 });
    await client.pharmacy.getOrder('EPO000000000001', { customer_details: { api_customer_id: 'CUST1001' } });
    const urls = apiCalls().map((c) => `${c.url.pathname}?${decodeURIComponent(c.url.search.slice(1))}`);
    expect(urls).toEqual([
      '/api/epharmacy/cart?customer_details[api_customer_id]=CUST1001&plan_id=EXAMPLE_PLAN',
      '/api/epharmacy/fulfillment_options?customer_details[api_customer_id]=CUST1001&cart_id=701',
      '/api/epharmacy/orders?customer_details[api_customer_id]=CUST1001&page=1&per_page=10',
      '/api/epharmacy/orders/EPO000000000001?customer_details[api_customer_id]=CUST1001',
    ]);
  });

  it('updateCart (JSON), payment details, create, cancel and confirm', async () => {
    const { client, apiCalls } = setup({
      'POST /api/epharmacy/orders': () =>
        json({ success: true, status: 'payment_pending', booking_id: 90002, payment_link: 'https://pay.example.com/abc' }),
    });
    const cart = {
      plan_id: 'EXAMPLE_PLAN',
      customer_details: { api_customer_id: 'CUST1001' },
      products: [
        { id: 50001, quantity: 2 },
        { id: 50002, quantity: 0 },
      ],
    };
    await client.pharmacy.updateCart(cart);
    await client.pharmacy.getOrderPaymentDetails({
      customer_details: { api_customer_id: 'CUST1001' },
      cart_id: 701,
      selected_delivery_option: 'standard',
      medicine_vendor_id: 3,
    });
    const order = await client.pharmacy.createOrder({
      customer_details: { api_customer_id: 'CUST1001' },
      cart_id: 701,
      delivery_option: 'standard',
      location_token: 'OPAQUE_TOKEN',
    });
    await client.pharmacy.cancelOrder('EPO000000000001', {
      customer_details: { api_customer_id: 'CUST1001' },
      reason: 'Ordered by mistake',
    });
    await client.pharmacy.confirmOrder('EPO000000000003', {
      customer_details: { api_customer_id: 'CUST1001' },
      partner_collected_amount: '261.0',
      partner_payment_reference: 'TXN-0001',
    });
    expect(order.status).toBe('payment_pending');
    const calls = apiCalls();
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'PATCH /api/epharmacy/cart',
      'POST /api/epharmacy/orders/payment_details',
      'POST /api/epharmacy/orders',
      'PATCH /api/epharmacy/orders/EPO000000000001/cancel',
      'POST /api/epharmacy/orders/EPO000000000003/confirm',
    ]);
    expect(await jsonBody(calls[0])).toEqual(cart);
    expect(await jsonBody(calls[2])).toMatchObject({ delivery_option: 'standard', location_token: 'OPAQUE_TOKEN' });
    expect(await jsonBody(calls[4])).toMatchObject({ partner_collected_amount: '261.0' });
  });

  it('getPrescriptionDigitization', async () => {
    const { client, last } = setup();
    await client.pharmacy.getPrescriptionDigitization('DIGI_RQ_A1B2C3D4E');
    expect(`${last().method} ${last().url.pathname}`).toBe('GET /api/prescriptions/digitize/DIGI_RQ_A1B2C3D4E');
  });
});

describe('wallet', () => {
  it('getCustomerWallet and listCustomerPlans', async () => {
    const { client, apiCalls } = setup();
    await client.wallet.getCustomerWallet('example-co', { api_customer_id: 'CUST1001', customer_plan_id: 101 });
    await client.wallet.listCustomerPlans('example-co', { customer_id: 'EKI000000001' });
    expect(apiCalls().map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      'GET /api/example-co/customers/wallet?api_customer_id=CUST1001&customer_plan_id=101',
      'GET /api/example-co/customers/plans?customer_id=EKI000000001',
    ]);
  });
});

describe('testing (staging only)', () => {
  it('calls the simulators on staging', async () => {
    const { client, apiCalls } = setup();
    await client.testing.simulateAppointmentStatus('APT1A2B3C4D5', { status: 'confirm' });
    await client.testing.simulateConsultationStatus('APT1A2B3C4D5', {
      status: 'reschedule',
      reschedule_time: '2026-01-16T04:30:00Z',
    });
    await client.testing.simulateOrderStatus('EPO000000000001', {
      customer_details: { api_customer_id: 'CUST1001' },
      status: 'in_progress',
    });
    const calls = apiCalls();
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'POST /api/appointments/APT1A2B3C4D5/update_status',
      'PATCH /api/consultations/APT1A2B3C4D5/update_status',
      'PATCH /api/epharmacy/orders/EPO000000000001/update_status',
    ]);
    expect(await jsonBody(calls[0])).toEqual({ status: 'confirm' });
  });

  it('refuses to call them in production', async () => {
    const { client, calls } = setup({}, 'production');
    await expect(
      client.testing.simulateAppointmentStatus('APT1A2B3C4D5', { status: 'confirm' }),
    ).rejects.toBeInstanceOf(HlthstackBaseError);
    expect(calls).toHaveLength(0);
  });
});
