import type { FeatureModule } from '../contracts';
import { unavailableGate, unavailableModule } from '../http';

export const findings: FeatureModule = unavailableModule('findings', [
  /^\/v1\/repos\/[^/]+\/changes\/[^/]+\/(?:findings|repairs(?:\/[^/]+\/review)?)$/,
]);
findings.hooks['findings.gate'] = () => unavailableGate();
