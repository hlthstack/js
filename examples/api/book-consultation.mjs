// In-clinic doctor consultation with plain fetch. Run against staging with:
//   HLTHSTACK_USERNAME=... HLTHSTACK_PASSWORD=... node examples/api/book-consultation.mjs
// Replace the package id and member details with your own.
import { api } from './client.mjs';

const PACKAGE_IDS = '2001';
const PINCODE = '500084';

// Doctors near the member, then a slot for the first one.
const { providers } = await api('GET', '/api/consultations/inclinic_consultation/providers', {
  query: { package_ids: PACKAGE_IDS, pincode: PINCODE },
});
const doctor = providers[0];
if (!doctor) throw new Error('No doctor found');
const slots = await api('GET', `/api/providers/${doctor.provider_id}/inclinic_consultation/slots`, {
  query: { package_ids: PACKAGE_IDS },
});
const slot = (slots.booking_slots ?? []).flatMap((day) => day.slots ?? []).find((s) => s.available);
if (!slot) throw new Error('No free slot');

// Book. appointment_date_time must be in the future; address (with pincode) is required.
const consultation = await api('POST', '/api/consultations/inclinic_consultation', {
  body: {
    appointment_date_time: slot.utc_slot_time,
    service_mode: 'at_provider_location',
    provider_id: doctor.provider_id,
    customers: [
      {
        name: 'Jane Doe',
        dob: '1990-08-24',
        mobile_number: '9999999999',
        api_customer_id: 'CUST1001',
        gender: 'female',
        package_ids: [Number(PACKAGE_IDS)],
      },
    ],
    address: {
      address_line_one: '1 Example Road',
      address_line_two: 'Kondapur',
      city: 'Hyderabad',
      state: 'Telangana',
      country: 'India',
      pincode: PINCODE,
      latitude: 17.47,
      longitude: 78.35,
    },
  },
});
const appointmentId = consultation.customers[0].appointment_id;
const details = await api('GET', `/api/consultations/inclinic_consultation/${appointmentId}`);
console.log('Booked', appointmentId, details);
