import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import ts from 'typescript';

type Config = Record<string, unknown>;
export type CheckResult = { status: 'ready' | 'unavailable' | 'failed'; checks: string[]; reason?: string };

function object(value: unknown): Config {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('configuration object required');
  return value as Config;
}

async function readConfig(path: string): Promise<Config> {
  const parsed = ts.parseConfigFileTextToJson(path, await readFile(path, 'utf8'));
  if (parsed.error) throw new Error(`invalid ${path}`);
  return object(parsed.config);
}

function bindingNames(config: Config, section: string): string[] {
  const value = config[section];
  if (section === 'durable_objects') return (object(value).bindings as Config[]).map(item => String(item.name));
  return (value as Config[]).map(item => String(item.binding));
}

function validateConfig(production: Config, local: Config, env: NodeJS.ProcessEnv): string[] {
  const checks: string[] = [];
  const vars = object(production.vars);
  const localVars = object(local.vars);
  if (vars.CONCORD_MODE !== 'production' || vars.STORAGE_BACKEND !== 'artifacts') throw new Error('production must use Artifacts');
  if (localVars.CONCORD_MODE !== 'local' || !['fake', 'bridge'].includes(String(localVars.STORAGE_BACKEND))) throw new Error('local Worker configuration is invalid');
  if (vars.CONCORD_SHOW_DECOMPILED_C !== '0' || (env.CONCORD_SHOW_DECOMPILED_C !== undefined && env.CONCORD_SHOW_DECOMPILED_C !== '0')) throw new Error('decompiled C must remain disabled');
  if (vars.BRIDGE_URL !== undefined || vars.LOCAL_GIT_URL !== undefined || vars.LOCAL_GIT_TOKEN !== undefined ||
      (env.CONCORD_MODE === 'production' && (env.BRIDGE_URL || env.LOCAL_GIT_URL || (env.STORAGE_BACKEND && env.STORAGE_BACKEND !== 'artifacts')))) throw new Error('production cannot use the local Git bridge');
  if (['AUTH_TOKENS', 'TRUSTED_CONFIG', 'CONCORD_TOKEN', 'CLOUDFLARE_API_TOKEN'].some(key => vars[key] !== undefined)) throw new Error('credentials and trusted config must be Worker secrets');
  if (JSON.stringify(production).includes('local-') || (env.AUTH_TOKENS ?? '').includes('local-')) throw new Error('fixture credentials cannot be used in production');
  const artifacts = production.artifacts as Config[];
  if (!Array.isArray(artifacts) || artifacts.length !== 1 || artifacts[0].binding !== 'ARTIFACTS' || artifacts[0].namespace !== 'concord-demo') throw new Error('Artifacts binding or namespace is missing');
  if (production.main !== 'src/worker.ts' || object(production.assets).binding !== 'ASSETS') throw new Error('Worker entrypoint or assets binding is missing');
  const doNames = bindingNames(production, 'durable_objects');
  if (!doNames.includes('TENANT_CATALOG') || !doNames.includes('REPO_COORDINATOR')) throw new Error('Durable Object bindings are missing');
  if (!Array.isArray(production.migrations) || production.migrations.length === 0) throw new Error('Durable Object migration is missing');
  checks.push('production config: Artifacts, Durable Objects, assets, and migrations');
  checks.push('local config: local mode with fake/bridge backend');
  checks.push('content and credentials: safe defaults');
  return checks;
}

const fixtureTokens = ['local-owner', 'local-agent-a', 'local-agent-b', 'local-agent-c', 'local-reviewer', 'local-checker', 'local-promoter', 'local-viewer', 'local-contest-low', 'local-contest-high', 'local-mock-aw'];
const fixtureDigests = new Set(fixtureTokens.map(token => createHash('sha256').update(token).digest('hex')));

function validateCredentialMap(raw: string): void {
  let mapping: Config;
  try { mapping = object(JSON.parse(raw)); } catch { throw new Error('production credential mapping is invalid'); }
  if (raw.includes('local-') || Object.keys(mapping).some(key => fixtureDigests.has(key))) throw new Error('fixture credentials cannot be used in production');
}

export async function checkLocal(root = process.cwd(), env = process.env): Promise<CheckResult> {
  try {
    const production = await readConfig(resolve(root, 'wrangler.jsonc'));
    const local = await readConfig(resolve(root, 'wrangler.local.jsonc'));
    const checks = validateConfig(production, local, env);
    if (env.AUTH_TOKENS) validateCredentialMap(env.AUTH_TOKENS);
    if (env.AUTH_TOKENS_FILE) validateCredentialMap(await readFile(env.AUTH_TOKENS_FILE, 'utf8'));
    if (env.TRUSTED_CONFIG_FILE && (await readFile(env.TRUSTED_CONFIG_FILE, 'utf8')).includes('local-demo')) throw new Error('local fixture policy cannot be used in production');
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22 or newer required');
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 5000 });
    for (const path of ['src/worker.ts', 'local/git-bridge.ts', 'runner/main.ts', 'node_modules/.bin/wrangler']) {
      if (!(await stat(resolve(root, path))).isFile()) throw new Error(`${path} is not a file`);
    }
    checks.push('local readiness: Node 22+, native Git, Worker, bridge, runner, and Wrangler');
    return { status: 'ready', checks, reason: 'remote deployment unavailable: owner credentials required' };
  } catch (error) {
    return { status: 'failed', checks: [], reason: error instanceof Error ? error.message : 'preflight failed' };
  }
}

export async function checkRemote(env = process.env, fetcher: typeof fetch = fetch): Promise<CheckResult> {
  const local = await checkLocal(process.cwd(), env);
  if (local.status !== 'ready') return local;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) return { status: 'unavailable', checks: local.checks, reason: 'owner credentials required' };
  if (!/^[a-f0-9]{32}$/i.test(account)) return { status: 'failed', checks: local.checks, reason: 'invalid Cloudflare account ID' };
  try {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/artifacts/namespaces/concord-demo`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return { status: 'unavailable', checks: local.checks, reason: `Artifacts namespace unavailable (HTTP ${response.status})` };
    const payload = await response.json() as { success?: boolean; result?: { namespace?: string } };
    if (payload.success !== true) return { status: 'unavailable', checks: local.checks, reason: 'Artifacts namespace unavailable' };
    return { status: 'ready', checks: [...local.checks, 'remote account and Artifacts namespace available'] };
  } catch {
    return { status: 'unavailable', checks: local.checks, reason: 'Artifacts availability check failed' };
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let mode: 'local' | 'remote';
  try {
    const parsed = parseArgs({ args: argv, options: { local: { type: 'boolean' }, remote: { type: 'boolean' } }, strict: true });
    if (parsed.values.local === parsed.values.remote) throw new Error('choose exactly one of --local or --remote');
    mode = parsed.values.remote ? 'remote' : 'local';
  } catch {
    console.error('usage: npm run deploy:check -- --local|--remote');
    return 2;
  }
  const result = mode === 'local' ? await checkLocal() : await checkRemote();
  console.log(JSON.stringify({ mode, ...result }));
  return result.status === 'ready' ? 0 : result.status === 'unavailable' ? 2 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  process.exitCode = await main();
}
