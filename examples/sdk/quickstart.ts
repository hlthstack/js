// Quickstart from docs/sdk-integration.md. Run against staging with:
//   HLTHSTACK_USERNAME=... HLTHSTACK_PASSWORD=... npx tsx examples/sdk/quickstart.ts
import { Hlthstack } from 'hlthstack';

const client = new Hlthstack({
  username: process.env.HLTHSTACK_USERNAME!,
  password: process.env.HLTHSTACK_PASSWORD!,
  environment: 'staging',
});

// 1. Find providers. The access token is requested on the first call and reused.
const { providers } = await client.appointments.listProviders({
  service_name: 'ahc',
  package_ids: '1001',
  pincode: '500081',
});
const provider = providers[0]!;

// 2. Pick a slot.
const slots = await client.appointments.listSlots(provider.provider_id!, 'ahc', {
  package_ids: '1001',
  pincode: '500081',
});
const slot = slots.booking_slots?.flatMap((day) => day.slots ?? []).find((s) => s.available);

// 3. Book.
const booking = await client.appointments.create({
  provider_id: provider.provider_id!,
  appointment_date_time: slot!.utc_slot_time!,
  appointment_type: 'home_collection',
  service_name: 'ahc',
  customers: [
    {
      name: 'Jane Doe',
      dob: '1990-08-24',
      mobile_number: '9999999999',
      api_customer_id: 'CUST1001',
      gender: 'female',
      package_ids: [1001],
      booking_customer: true,
    },
  ],
  address: {
    address_line_one: '1 Example Road',
    address_line_two: 'Madhapur',
    city: 'Hyderabad',
    state: 'Telangana',
    country: 'India',
    pincode: '500081',
    latitude: 17.4437,
    longitude: 78.386,
  },
});

if (booking.status === 'payment_pending') {
  // send booking.payment_link to the member
}

// 4. Read it back.
const details = await client.appointments.get({ booking_id: booking.booking_id });
console.log(details.appointments.map((a) => [a.appointment_id, a.status]));
