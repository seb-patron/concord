import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { inspect, prepareLocal, scene, seed, wranglerStateDir, type Options } from './scenarios';
import { demoPrincipals, provision } from './provision';

async function parse(args: string[]): Promise<{ command: string; sceneName?: string; options: Options; local: boolean }> {
  const [command, ...rest] = args;
  const sceneName = command === 'scene' ? rest.shift() : undefined;
  if (!['seed', 'scene', 'inspect', 'preflight', 'provision'].includes(command ?? '') || command === 'scene' && !sceneName) {
    throw new Error('Usage: npm run demo -- provision --out-dir DIR | seed|scene|inspect --target local|remote --url URL --tokens-file FILE --state-dir DIR');
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index];
    if (['--pump-local', '--json', '--local'].includes(key)) values.set(key, 'true');
    else if (['--run', '--state-dir', '--url', '--target', '--tokens-file', '--out-dir'].includes(key) && rest[index + 1]) values.set(key, rest[++index]);
    else throw new Error('Unknown or incomplete option: ' + key);
  }
  if (command === 'provision') {
    if (values.size !== 1 || !values.get('--out-dir')) throw new Error('PROVISION_OUT_DIR_REQUIRED');
    return { command, options: { run: '', stateDir: values.get('--out-dir')!, url: '', pumpLocal: false, json: false, target: 'local', actors: {} }, local: false };
  }
  if (values.has('--out-dir')) throw new Error('INVALID_OUT_DIR_OPTION');
  const target = values.get('--target') ?? 'local';
  if (target !== 'local' && target !== 'remote') throw new Error('INVALID_TARGET');
  if (target === 'remote' && values.has('--pump-local')) throw new Error('PUMP_LOCAL_FORBIDDEN_IN_REMOTE_MODE');
  if (target === 'remote' && (!values.get('--url') || !values.get('--tokens-file'))) throw new Error('REMOTE_URL_AND_TOKENS_FILE_REQUIRED');
  if (target === 'local' && values.has('--tokens-file')) throw new Error('TOKENS_FILE_REQUIRES_REMOTE_TARGET');
  const url = values.get('--url') ?? process.env.CONCORD_URL ?? 'http://127.0.0.1:8787';
  if (target === 'remote') {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(parsed.hostname))) throw new Error('UNSAFE_REMOTE_URL');
  }
  const actors: Record<string, string> = {};
  if (target === 'remote') {
    const parsed: unknown = JSON.parse(await readFile(values.get('--tokens-file')!, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_TOKENS_FILE');
    for (const alias of Object.keys(demoPrincipals)) {
      const token = (parsed as Record<string, unknown>)[alias];
      if (typeof token !== 'string' || !token || token.startsWith('local-') || /\s/.test(token)) throw new Error('INVALID_TOKENS_FILE');
      actors[alias] = token;
    }
  }
  const stateDir = values.get('--state-dir') ?? process.env.CONCORD_RUN_DIR;
  if (!stateDir) throw new Error('STATE_DIR_REQUIRED');
  const options: Options = { run: values.get('--run') ?? 'demo-01', stateDir,
    url, pumpLocal: values.has('--pump-local'), json: values.has('--json'), target, actors };
  if (process.env.CONCORD_SHOW_DECOMPILED_C && process.env.CONCORD_SHOW_DECOMPILED_C !== '0') {
    throw new Error('CONCORD_SHOW_DECOMPILED_C must be 0 for this public fixture');
  }
  return { command, sceneName, options, local: values.has('--local') };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { command, sceneName, options, local } = await parse(args);
  if (command === 'provision') {
    process.stdout.write(JSON.stringify(await provision(options.stateDir)) + '\n');
    return;
  }
  if (command === 'preflight') {
    if (!local) throw new Error('Only --local preflight is part of slice 12a');
    const { profile, trustedConfig } = await prepareLocal(options.stateDir);
    process.stdout.write(JSON.stringify({ status: 'ready', profilePath: profile.sourcePath, profileDigest: profile.digest,
      trustedConfigPath: resolve(options.stateDir, 'trusted-config.json'),
      workerCommand: `npm run dev -- --persist-to ${wranglerStateDir(options.stateDir)} --var STORAGE_BACKEND:bridge --var BRIDGE_URL:http://127.0.0.1:8788/?token=<bridge-token> --var TRUSTED_CONFIG:'${trustedConfig}'`,
      remoteDeployment: 'unavailable until owner provisions an account' }, null, 2) + '\n');
    return;
  }
  if (command === 'seed') {
    const manifest = await seed(options);
    process.stdout.write(JSON.stringify({ repoId: manifest.repoId, canonicalOid: manifest.canonicalOid,
      manifestPath: resolve(options.stateDir, options.run + '.json'), repoUrl: `${options.url}/repos/${manifest.repoId}` }, null, 2) + '\n');
    return;
  }
  if (command === 'scene') {
    const manifest = await scene(options, sceneName!);
    process.stdout.write(JSON.stringify({ scene: sceneName, repoId: manifest.repoId, canonicalOid: manifest.canonicalOid,
      evidence: manifest.evidence[sceneName!] }, null, 2) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(await inspect(options), null, options.json ? 2 : 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(String(error instanceof Error ? error.message : error) + '\n'); process.exitCode = 1; });
}
