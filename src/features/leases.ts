import type { FeatureModule } from '../contracts';
import { unavailableGate, unavailableModule } from '../http';

export const leases: FeatureModule = unavailableModule('leases', [
  /^\/v1\/repos\/[^/]+\/leases(?:\/[^/]+(?:\/(?:renew|release))?)?$/,
]);
leases.hooks['leases.reserve'] = () => unavailableGate();
leases.hooks['leases.releaseReservation'] = () => unavailableGate();
