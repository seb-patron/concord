import type { FeatureModule } from '../contracts';
import { unavailableGate, unavailableModule } from '../http';

export const queue: FeatureModule = unavailableModule('queue', [
  /^\/v1\/repos\/[^/]+\/(?:queue(?:\/(?:enqueue|withdraw))?|contests)$/,
]);
queue.hooks['queue.onResult'] = () => unavailableGate();
