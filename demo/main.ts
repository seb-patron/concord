import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect, prepareLocal, scene, seed, type Options } from './scenarios';

function parse(args: string[]): { command: string; sceneName?: string; options: Options; local: boolean } {
  const [command, ...rest] = args;
  const sceneName = command === 'scene' ? rest.shift() : undefined;
  if (!['seed', 'scene', 'inspect', 'preflight'].includes(command ?? '') || command === 'scene' && !sceneName) {
    throw new Error('Usage: npm run demo -- preflight --local --state-dir DIR | seed --run ID --state-dir DIR | scene NAME --run ID --state-dir DIR [--pump-local] | inspect --run ID --state-dir DIR --json');
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index];
    if (['--pump-local', '--json', '--local'].includes(key)) values.set(key, 'true');
    else if (['--run', '--state-dir', '--url'].includes(key) && rest[index + 1]) values.set(key, rest[++index]);
    else throw new Error('Unknown or incomplete option: ' + key);
  }
  const stateDir = values.get('--state-dir') ?? process.env.CONCORD_RUN_DIR;
  if (!stateDir) throw new Error('STATE_DIR_REQUIRED');
  const options: Options = { run: values.get('--run') ?? 'demo-01', stateDir,
    url: values.get('--url') ?? process.env.CONCORD_URL ?? 'http://127.0.0.1:8787',
    pumpLocal: values.has('--pump-local'), json: values.has('--json') };
  if (process.env.CONCORD_SHOW_DECOMPILED_C && process.env.CONCORD_SHOW_DECOMPILED_C !== '0') {
    throw new Error('CONCORD_SHOW_DECOMPILED_C must be 0 for this public fixture');
  }
  return { command, sceneName, options, local: values.has('--local') };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { command, sceneName, options, local } = parse(args);
  if (command === 'preflight') {
    if (!local) throw new Error('Only --local preflight is part of slice 12a');
    const { profile, trustedConfig } = await prepareLocal(options.stateDir);
    process.stdout.write(JSON.stringify({ status: 'ready', profilePath: profile.sourcePath, profileDigest: profile.digest,
      trustedConfigPath: resolve(options.stateDir, 'trusted-config.json'),
      workerCommand: `npm run dev -- --var STORAGE_BACKEND:bridge --var BRIDGE_URL:http://127.0.0.1:8788/?token=<bridge-token> --var TRUSTED_CONFIG:'${trustedConfig}'`,
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
