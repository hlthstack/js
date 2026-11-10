// ePharmacy order with plain fetch: search, cart, fulfillment options, order.
//   HLTHSTACK_USERNAME=... HLTHSTACK_PASSWORD=... node examples/api/pharmacy-order.mjs
import { api } from './client.mjs';

const member = { api_customer_id: 'CUST1001' };

// 1. Find a medicine id (the search parameter is `name`, at least 3 characters).
const { medicines } = await api('GET', '/api/epharmacy/medicines/search', { query: { name: 'paracetamol' } });
const medicine = medicines.find((m) => m.available && !m.rx_required);
if (!medicine) throw new Error('No medicine found');

// 2. Put it in the member's cart with a delivery address (one cart per member per plan).
const { cart } = await api('PATCH', '/api/epharmacy/cart', {
  body: {
    customer_details: { ...member, name: 'Jane Doe', mobile_number: '9999999999', gender: 'female', dob: '1990-08-24' },
    products: [{ id: medicine.id, quantity: 2 }],
    address: { line1: '1 Example Road', line2: 'Motera', city: 'Ahmedabad', state: 'Gujarat', pincode: '380005' },
  },
});

// 3. Delivery options (slow: 3-8 s). HTTP 200 can still carry success: false inside.
const options = await api('GET', '/api/epharmacy/fulfillment_options', {
  query: { 'customer_details[api_customer_id]': member.api_customer_id, cart_id: cart.id },
});
const standard = options.delivery_options?.success ? options.delivery_options.standard : undefined;
if (!standard) throw new Error('Standard delivery is not available for this cart');

// 4. Place the order with the chosen option's vendor_id and location_token.
const order = await api('POST', '/api/epharmacy/orders', {
  body: {
    customer_details: member,
    cart_id: cart.id,
    delivery_option: 'standard',
    medicine_vendor_id: standard.vendor_id,
    location_token: standard.location_token,
  },
});
console.log(order.status, order.user_prescription_details?.unique_id, order.payment_link ?? '');
