/** Canonical path validation shared by public routes and the local Git bridge. */
export function isRepoPath(value: unknown, allowRoot = false): value is string {
  if (typeof value !== 'string') return false;
  if (value === '' && allowRoot) return true;
  if (new TextEncoder().encode(value).byteLength > 4096 || value.startsWith('/') || value.includes('\0')) return false;
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

export function assertRepoPath(value: unknown, allowRoot = false): asserts value is string {
  if (!isRepoPath(value, allowRoot)) throw new Error('INVALID_PATH');
}
