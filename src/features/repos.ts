import type { FeatureModule } from '../contracts';
import { unavailableGate, unavailableModule } from '../http';

export const repos: FeatureModule = unavailableModule('repos', [
  /^\/v1\/repos$/,
  /^\/v1\/repos\/[^/]+$/,
  /^\/v1\/repos\/[^/]+\/(?:bootstrap|branches|git-token)(?:\/[^/]+)?$/,
  /^\/v1\/repos\/[^/]+\/changes(?:\/[^/]+(?:\/(?:publish|close))?)?$/,
]);
repos.hooks['repos.inspectRevision'] = () => unavailableGate();
