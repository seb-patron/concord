import type { FeatureModule } from '../contracts';
import { unavailableGate, unavailableModule } from '../http';

export const runners: FeatureModule = unavailableModule('runners', [
  /^\/v1\/repos\/[^/]+\/runner\/poll$/,
  /^\/v1\/repos\/[^/]+\/jobs\/[^/]+\/(?:heartbeat|result|credentials)$/,
]);
runners.hooks['runners.schedule'] = () => unavailableGate();
