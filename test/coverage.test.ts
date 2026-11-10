import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';
import { makeClient, mockFetch } from './helpers.js';

/** operationId (from the spec) -> client method. Keep in sync with the README table. */
const METHODS: Record<string, string> = {
  getAccessToken: 'auth.getAccessToken',
  listProviders: 'appointments.listProviders',
  listSlots: 'appointments.listSlots',
  createAppointment: 'appointments.create',
  getAppointment: 'appointments.get',
  listCustomerAppointments: 'appointments.listForCustomer',
  getAppointmentPaymentDetails: 'appointments.getPaymentDetails',
  rescheduleBooking: 'appointments.rescheduleBooking',
  cancelBooking: 'appointments.cancelBooking',
  rescheduleAppointment: 'appointments.reschedule',
  cancelAppointment: 'appointments.cancel',
  getAppointmentVoucher: 'appointments.getVoucher',
  getAppointmentReports: 'appointments.getReports',
  getAppointmentLabResults: 'appointments.getLabResults',
  listInclinicConsultationProviders: 'consultations.listInclinicProviders',
  listSpecialistConsultationProviders: 'consultations.listSpecialistProviders',
  createInclinicConsultation: 'consultations.createInclinic',
  createSpecialistConsultation: 'consultations.createSpecialist',
  getInclinicConsultation: 'consultations.getInclinic',
  getSpecialistConsultation: 'consultations.getSpecialist',
  rescheduleConsultation: 'consultations.reschedule',
  cancelConsultation: 'consultations.cancel',
  getConsultationSummaryAndPrescription: 'consultations.getSummaryAndPrescription',
  getConsultationVoucher: 'consultations.getVoucher',
  uploadConsultationDocuments: 'consultations.uploadDocuments',
  searchMedicines: 'pharmacy.searchMedicines',
  digitizePrescription: 'pharmacy.digitizePrescription',
  getPrescriptionDigitization: 'pharmacy.getPrescriptionDigitization',
  getCart: 'pharmacy.getCart',
  updateCart: 'pharmacy.updateCart',
  getFulfillmentOptions: 'pharmacy.getFulfillmentOptions',
  getOrderPaymentDetails: 'pharmacy.getOrderPaymentDetails',
  createOrder: 'pharmacy.createOrder',
  listOrders: 'pharmacy.listOrders',
  getOrder: 'pharmacy.getOrder',
  cancelOrder: 'pharmacy.cancelOrder',
  confirmOrder: 'pharmacy.confirmOrder',
  getCustomerWallet: 'wallet.getCustomerWallet',
  listCustomerPlans: 'wallet.listCustomerPlans',
  getPreRegistrationAccessToken: 'preRegistration.getAccessToken',
  createPreRegistrations: 'preRegistration.create',
  updatePreRegistrations: 'preRegistration.update',
  deactivatePreRegistrations: 'preRegistration.deactivate',
  getPreRegistrationStatus: 'preRegistration.getStatus',
  simulateAppointmentStatus: 'testing.simulateAppointmentStatus',
  simulateConsultationStatus: 'testing.simulateConsultationStatus',
  simulateOrderStatus: 'testing.simulateOrderStatus',
};

describe('API coverage', () => {
  const spec = readFileSync(new URL('../openapi/openapi.yaml', import.meta.url), 'utf8');
  const [pathsPart] = spec.split(/^webhooks:/m);
  const operationIds = [...pathsPart!.matchAll(/operationId: (\w+)/g)].map((m) => m[1]);

  it('has one client method per spec operation', () => {
    expect(operationIds).toHaveLength(47);
    expect(Object.keys(METHODS).sort()).toEqual([...operationIds].sort());
  });

  it('every mapped method exists', () => {
    const client = makeClient(mockFetch().fetch) as unknown as Record<string, Record<string, unknown>>;
    for (const target of Object.values(METHODS)) {
      const [ns, method] = target.split('.') as [string, string];
      expect(typeof client[ns]?.[method], target).toBe('function');
    }
  });

  it('VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
