// Health-checkup booking end to end with plain fetch. Run against staging with:
//   HLTHSTACK_USERNAME=... HLTHSTACK_PASSWORD=... node examples/api/book-health-checkup.mjs
// Replace the package id and member details with your own (package ids are shared at onboarding).
import { writeFile } from 'node:fs/promises';
import { api } from './client.mjs';

const PACKAGE_IDS = '1001';
const PINCODE = '500081';

// 1. Providers near the member that offer the package (sorted by distance).
const { providers } = await api('GET', '/api/providers', {
  query: { service_name: 'ahc', package_ids: PACKAGE_IDS, pincode: PINCODE },
});
const provider = providers.find((p) => p.home_collection_enabled) ?? providers[0];
if (!provider) throw new Error('No provider serves this package here');

// 2. Bookable slots for that provider (up to 14 days when booking_date is omitted).
const slots = await api('GET', `/api/providers/${provider.provider_id}/ahc/slots`, {
  query: { package_ids: PACKAGE_IDS, pincode: PINCODE },
});
const available = (slots.booking_slots ?? []).flatMap((day) => day.slots ?? []).filter((s) => s.available);
if (available.length < 2) throw new Error('Not enough free slots');

// 3. Book. appointment_date_time is a slot's utc_slot_time.
const booking = await api('POST', '/api/appointments', {
  body: {
    provider_id: provider.provider_id,
    appointment_date_time: available[0].utc_slot_time,
    appointment_type: 'home_collection',
    service_name: 'ahc',
    customers: [
      {
        name: 'Jane Doe',
        dob: '1990-08-24',
        mobile_number: '9999999999',
        api_customer_id: 'CUST1001',
        gender: 'female',
        package_ids: [Number(PACKAGE_IDS)],
        booking_customer: true,
      },
    ],
    address: {
      address_line_one: '1 Example Road',
      address_line_two: 'Madhapur',
      city: 'Hyderabad',
      state: 'Telangana',
      country: 'India',
      pincode: PINCODE,
      latitude: 17.4437,
      longitude: 78.386,
    },
  },
});
if (booking.status === 'payment_pending') console.log('Send this link to the member:', booking.payment_link);
const appointmentId = booking.customers[0].appointment_id;
console.log('Booked', booking.booking_id, appointmentId);

// 4. Read it back (one entry per member in the booking).
const details = await api('GET', '/api/appointments', {
  query: { booking_id: booking.booking_id, appointment_id: appointmentId },
});
const appointment = details.appointments[0];
console.log('Status:', appointment.status);

// 5. Move it to another slot.
await api('PATCH', `/api/appointments/${appointmentId}/reschedule`, {
  body: { appointment_date_time: available[1].utc_slot_time },
});

// 6. The voucher PDF exists only once the provider has confirmed the appointment.
if (appointment.status === 'confirmed') {
  const pdf = await api('GET', `/api/appointments/${appointmentId}/voucher`, { binary: true });
  await writeFile(`voucher-${appointmentId}.pdf`, pdf);
}

// 7. Cancel (this example cleans up after itself).
await api('PATCH', `/api/appointments/${appointmentId}/cancel`);
console.log('Cancelled', appointmentId);
