import { createHash, randomBytes } from 'node:crypto';
import { mkdir, realpath, writeFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const demoPrincipals = {
  owner: ['owner', 'owner'], A: ['agent-a', 'agent'], B: ['agent-b', 'agent'], C: ['agent-c', 'agent'],
  reviewer: ['reviewer', 'reviewer'], checker: ['checker', 'checker'], promoter: ['promoter', 'promoter'],
  low: ['contest-agent-low', 'agent'], high: ['contest-agent-high', 'agent'], aw: ['mock-aw', 'agent'],
} as const;

const clone = resolve(fileURLToPath(new URL('..', import.meta.url)));
const inside = (root: string, path: string) => { const part = relative(root, path); return part === '' || (!part.startsWith('..') && !isAbsolute(part)); };

/** Both outputs are operator secrets. Refuse symlink paths and existing files. */
export async function provision(outDir: string): Promise<{ authTokensFile: string; tokensFile: string }> {
  if (!outDir || !isAbsolute(outDir)) throw new Error('PROVISION_DIR_MUST_BE_ABSOLUTE');
  const target = resolve(outDir);
  if (inside(clone, target)) throw new Error('PROVISION_DIR_MUST_BE_OUTSIDE_REPO');
  let ancestor = target;
  for (;;) {
    try {
      if (inside(clone, await realpath(ancestor))) throw new Error('PROVISION_DIR_MUST_BE_OUTSIDE_REPO');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  const physical = await realpath(target);
  if (inside(clone, physical)) throw new Error('PROVISION_DIR_MUST_BE_OUTSIDE_REPO');
  const authTokensFile = join(physical, 'auth-tokens.json');
  const tokensFile = join(physical, 'demo-tokens.json');
  const tokens: Record<string, string> = {};
  const auth: Record<string, { tenantId: string; principalId: string; roles: string[]; repoIds: '*'; expiresAt: number }> = {};
  for (const [alias, [principalId, role]] of Object.entries(demoPrincipals)) {
    let token: string;
    do { token = randomBytes(32).toString('base64url'); } while (token.startsWith('local-'));
    tokens[alias] = token;
    auth[createHash('sha256').update(token).digest('hex')] = { tenantId: 'demo', principalId, roles: [role], repoIds: '*', expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
  }
  await writeFile(authTokensFile, JSON.stringify(auth, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { await writeFile(tokensFile, JSON.stringify(tokens, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { await unlink(authTokensFile); throw error; }
  return { authTokensFile, tokensFile };
}
