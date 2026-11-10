// Pre-register a member and a dependant with plain fetch, then wait for the outcome.
//   HLTHSTACK_PREREG_USERNAME=... HLTHSTACK_PREREG_PASSWORD=... node examples/api/pre-registration.mjs
// Uses its own credentials and token, sent as X-EKINCARE-KEY (see client.mjs).
import { preRegistrationApi } from './client.mjs';

// Every required key must be present in every row, even when empty: rows missing one are
// dropped silently. At most 250 rows (employees + dependants) per request.
const { request_id } = await preRegistrationApi('POST', '/v1/corporate/pre_registrations', {
  body: {
    employees: [
      {
        employee_code: 'EMP1001', company_id: '1001', first_name: 'Jane', last_name: 'Doe',
        email: 'jane.doe@example.com', date_of_birth: '24-08-1990', gender: 'Female',
        mobile_number: '9999999999', vip: 'No', entity_name: '', employee_office_location: 'Hyderabad',
        department: 'Engineering', grade: 'B', date_of_joining: '01-01-2026',
      },
    ],
    dependants: [
      {
        guardian_email: 'jane.doe@example.com', dependent_code: 'DEP-001', first_name: 'John',
        last_name: 'Doe', date_of_birth: '10-02-1960', gender: 'Male', mobile_number: '9999999998',
        relation: 'Father',
      },
    ],
  },
});

// Processing is asynchronous: poll until status is completed.
let result = await preRegistrationApi('GET', `/v1/corporate/pre_registrations/${request_id}/status`);
while (result.status !== 'completed') {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  result = await preRegistrationApi('GET', `/v1/corporate/pre_registrations/${request_id}/status`);
}
console.log('Registered:', result.success_records.length);
for (const row of result.failure_records) console.log('Failed:', row.email ?? row.employee_code, row.errors);
