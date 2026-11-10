export { Hlthstack, Auth } from './client.js';
export { BASE_URLS } from './core.js';
export type { ClientOptions, Environment, RequestOptions } from './core.js';
export {
  HlthstackBaseError,
  HlthstackConnectionError,
  HlthstackError,
  HlthstackValidationError,
  extractErrorMessages,
} from './errors.js';
export { Appointments } from './resources/appointments.js';
export { Consultations } from './resources/consultations.js';
export { Pharmacy, type DigitizePrescriptionOptions } from './resources/pharmacy.js';
export { PreRegistration } from './resources/preRegistration.js';
export { Testing } from './resources/testing.js';
export { Wallet } from './resources/wallet.js';
export type { FileInput } from './uploads.js';
export * from './types.js';
export * from './webhooks.js';
export type { components, operations, paths, webhooks } from './generated/openapi.js';
export { VERSION } from './version.js';
