import type { FeatureModule } from '../contracts';
import { unavailableGate, unavailableModule } from '../http';

export const verdicts: FeatureModule = unavailableModule('verdicts', [
  /^\/v1\/repos\/[^/]+\/changes\/[^/]+\/(?:verdicts|carry)$/,
]);
verdicts.hooks['verdicts.gate'] = () => unavailableGate();
verdicts.hooks['verdicts.evaluateCarry'] = () => unavailableGate();
