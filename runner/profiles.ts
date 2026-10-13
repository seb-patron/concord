import { access, lstat, readFile, stat } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Job, CheckOutcome } from '../src/contracts';
import { digest, stableJson } from '../src/http';
import { childEnvironment, command, OUTPUT_CAP } from './git';

export type ExpectedRow = { retry_limit: number; timeout_ms: number; output: number };
export type LocalProfile = {
  id: string; digest: string; checkerId: string; checkerDigest: string;
  oracleDigest: string; toolchainDigest: string; environmentDigest: string;
  timeoutMs: number; maxOutputBytes: number;
  kind?: 'command'; cwd?: 'repo'; timeoutSeconds?: number; env?: string[]; outputCap?: number;
  executable?: string; argv?: string[]; successOutcome?: 'PASS' | 'MATCH'; checkerFile?: string; toolchainFile?: string; oracleFile?: string;
  cases?: Record<string, { rows: Record<string, ExpectedRow>; epsilonChoices?: ExpectedRow[] }>;
  /** Added by the loader; never included in the content digest. */
  sourcePath?: string;
};
const sha = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
/** Only noncredential runner settings may be forwarded to repository code. */
export const commandEnvNames = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'UV_CACHE_DIR', 'UV_PYTHON', 'UV_PROJECT_ENVIRONMENT', 'XDG_CACHE_HOME'] as const;
export const commandConfig = (profile: LocalProfile) => ({ executable: profile.executable, argv: profile.argv,
  cwd: profile.cwd, timeoutSeconds: profile.timeoutSeconds, env: profile.env, outputCap: profile.outputCap });
const fileDigest = async (path: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(resolve(path))) hash.update(chunk);
  return 'sha256:' + hash.digest('hex');
};
export const localEnvironment = () => ({ platform: process.platform, arch: process.arch, node: process.version });
export async function commandHostLine(profile: LocalProfile): Promise<string> {
  return `host=${process.platform}/${process.arch} node=${process.version} exe_sha256=${await fileDigest(profile.executable!)}\n`;
}
async function commandExecutableAvailable(profile: LocalProfile): Promise<void> {
  try {
    if (!(await stat(profile.executable!)).isFile()) throw new Error('not a file');
    await access(profile.executable!, constants.X_OK);
  } catch { throw new Error('ENV_ERROR: executable'); }
}
function validateCommandProfile(profile: LocalProfile): void {
  const invalid = (field: string): never => { throw new Error('INVALID_COMMAND_PROFILE: ' + field); };
  if (profile.checkerId === 'dispatch-lab') invalid('checkerId');
  if (!profile.executable || !isAbsolute(profile.executable)) invalid('executable');
  if (profile.toolchainFile !== profile.executable) invalid('toolchainFile');
  if (profile.cwd !== 'repo') invalid('cwd');
  if (!Array.isArray(profile.argv) || profile.argv.some(arg => typeof arg !== 'string' || /\{[^}]*\}/.test(arg))) invalid('argv');
  if (!Number.isSafeInteger(profile.timeoutSeconds) || !profile.timeoutSeconds || profile.timeoutSeconds < 1 ||
    profile.timeoutSeconds * 1000 > profile.timeoutMs) invalid('timeoutSeconds');
  if (!Number.isSafeInteger(profile.outputCap) || !profile.outputCap || profile.outputCap < 4096 ||
    profile.outputCap > profile.maxOutputBytes) invalid('outputCap');
  if (!Array.isArray(profile.env) || profile.env.some(name => typeof name !== 'string' ||
    !commandEnvNames.includes(name as typeof commandEnvNames[number])) || new Set(profile.env).size !== profile.env.length) invalid('env');
  for (const field of ['checkerFile', 'oracleFile', 'successOutcome', 'cases'] as const)
    if (profile[field] !== undefined) invalid(field);
}
export async function createCommandProfile(input: Record<string, unknown>): Promise<LocalProfile> {
  const allowed = ['id', 'checkerId', 'timeoutMs', 'maxOutputBytes', 'executable', 'argv', 'cwd', 'timeoutSeconds', 'env', 'outputCap'];
  for (const field of Object.keys(input)) if (!allowed.includes(field)) throw new Error('INVALID_PROFILE: ' + field);
  const config = input as Pick<LocalProfile, 'id' | 'checkerId' | 'timeoutMs' | 'maxOutputBytes' | 'executable' | 'argv' | 'cwd' | 'timeoutSeconds' | 'env' | 'outputCap'>;
  if (typeof config.id !== 'string') throw new Error('INVALID_PROFILE: id');
  if (typeof config.checkerId !== 'string') throw new Error('INVALID_PROFILE: checkerId');
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 35 * 60_000) throw new Error('INVALID_PROFILE: timeoutMs');
  if (!Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes < 1 || config.maxOutputBytes > OUTPUT_CAP) throw new Error('INVALID_PROFILE: maxOutputBytes');
  const profile = { ...config, kind: 'command' as const, toolchainFile: config.executable } as LocalProfile;
  validateCommandProfile(profile);
  await commandExecutableAvailable(profile);
  const pin = await digest(commandConfig(profile));
  const content = { ...profile, checkerDigest: pin, toolchainDigest: pin, oracleDigest: pin, environmentDigest: pin };
  return { ...content, digest: await digest(content) };
}
const validRow = (value: unknown): value is ExpectedRow => !!value && typeof value === 'object' &&
  Number.isSafeInteger((value as ExpectedRow).retry_limit) && (value as ExpectedRow).retry_limit >= 1 && (value as ExpectedRow).retry_limit <= 5 &&
  Number.isSafeInteger((value as ExpectedRow).timeout_ms) && (value as ExpectedRow).timeout_ms >= 250 && (value as ExpectedRow).timeout_ms <= 2000 &&
  Number.isSafeInteger((value as ExpectedRow).output);

// Reviewed fixture tuples, independent of candidate files. Even the B-containing
// cases pin the last valid gamma row: B's zero-valued row must fail the gate.
// A new case or changed tuple needs a reviewed revision and a new owner profile.
const alpha1 = { retry_limit: 1, timeout_ms: 1000, output: 1000 };
const alpha2 = { retry_limit: 2, timeout_ms: 1000, output: 2000 };
const alpha3 = { retry_limit: 3, timeout_ms: 1000, output: 3000 };
const alpha4 = { retry_limit: 4, timeout_ms: 1000, output: 4000 };
const beta2 = { retry_limit: 2, timeout_ms: 1000, output: 2000 };
const beta3 = { retry_limit: 3, timeout_ms: 1000, output: 3000 };
const gamma3 = { retry_limit: 3, timeout_ms: 1000, output: 3000 };
const gamma4 = { retry_limit: 4, timeout_ms: 1250, output: 5000 };
const gamma5 = { retry_limit: 5, timeout_ms: 1250, output: 6250 };
const delta4 = { retry_limit: 4, timeout_ms: 1000, output: 4000 };
const delta5 = { retry_limit: 5, timeout_ms: 1000, output: 5000 };
const deltaE = { retry_limit: 4, timeout_ms: 1500, output: 6000 };
const epsilon1 = { retry_limit: 1, timeout_ms: 500, output: 500 };
const epsilonLow = { retry_limit: 2, timeout_ms: 500, output: 1000 };
const epsilonHigh = { retry_limit: 2, timeout_ms: 1000, output: 2000 };
const zetaRow = { retry_limit: 2, timeout_ms: 750, output: 1500 };
const etaRow = { retry_limit: 3, timeout_ms: 750, output: 2250 };
const afterAw = { alpha: alpha3, beta: beta3, gamma: gamma5, delta: deltaE, epsilon: epsilonHigh };
const requiredDispatchCases: NonNullable<LocalProfile['cases']> = {
  seed: { rows: { alpha: alpha1, beta: beta2, gamma: gamma3, delta: delta4, epsilon: epsilon1 } },
  'a-only': { rows: { alpha: alpha2, beta: beta2, gamma: gamma3, delta: delta4, epsilon: epsilon1 } },
  'b-only': { rows: { alpha: alpha1, beta: beta2, gamma: gamma3, delta: delta4, epsilon: epsilon1 } },
  'c-only': { rows: { alpha: alpha1, beta: beta2, gamma: gamma3, delta: delta5, epsilon: epsilon1 } },
  'a-b': { rows: { alpha: alpha2, beta: beta2, gamma: gamma3, delta: delta4, epsilon: epsilon1 } },
  'a-c-survivors': { rows: { alpha: alpha2, beta: beta2, gamma: gamma3, delta: delta5, epsilon: epsilon1 } },
  'b-c': { rows: { alpha: alpha1, beta: beta2, gamma: gamma3, delta: delta5, epsilon: epsilon1 } },
  'a-b-c': { rows: { alpha: alpha2, beta: beta2, gamma: gamma3, delta: delta5, epsilon: epsilon1 } },
  'b-repaired': { rows: { alpha: alpha2, beta: beta2, gamma: gamma4, delta: delta5, epsilon: epsilon1 } },
  'd-only': { rows: { alpha: alpha3, beta: beta2, gamma: gamma4, delta: delta5, epsilon: epsilon1 } },
  'e-only': { rows: { alpha: alpha2, beta: beta2, gamma: gamma4, delta: deltaE, epsilon: epsilon1 } },
  'd-e': { rows: { alpha: alpha3, beta: beta2, gamma: gamma4, delta: deltaE, epsilon: epsilon1 } },
  'h-only': { rows: { alpha: alpha4, beta: beta2, gamma: gamma4, delta: deltaE, epsilon: epsilon1 } },
  'i-only': { rows: { alpha: alpha3, beta: beta3, gamma: gamma4, delta: deltaE, epsilon: epsilon1 } },
  'j-common': { rows: { alpha: alpha3, beta: beta3, gamma: gamma4, delta: deltaE, epsilon: epsilonLow },
    epsilonChoices: [epsilonLow, epsilonHigh] },
  'aw-only': { rows: { alpha: alpha3, beta: beta3, gamma: gamma5, delta: deltaE, epsilon: epsilonHigh } },
  'rows-zeta': { rows: { ...afterAw, zeta: zetaRow } },
  'rows-eta': { rows: { ...afterAw, eta: etaRow } },
  'rows-retire': { rows: { alpha: alpha3, beta: beta3, gamma: gamma5, delta: deltaE } },
  'rows-zeta-eta': { rows: { ...afterAw, zeta: zetaRow, eta: etaRow } },
  'rows-zeta-retire': { rows: { alpha: alpha3, beta: beta3, gamma: gamma5, delta: deltaE, zeta: zetaRow } },
  'rows-eta-retire': { rows: { alpha: alpha3, beta: beta3, gamma: gamma5, delta: deltaE, eta: etaRow } },
  'rows-all': { rows: { alpha: alpha3, beta: beta3, gamma: gamma5, delta: deltaE, zeta: zetaRow, eta: etaRow } },
};

export async function loadProfile(filename: string): Promise<LocalProfile> {
  if (!isAbsolute(filename)) throw new Error('PROFILE_ABSOLUTE_PATH_REQUIRED');
  const path = resolve(filename);
  const profile = JSON.parse(await readFile(path, 'utf8')) as LocalProfile;
  if (!profile || typeof profile !== 'object') throw new Error('INVALID_PROFILE: object');
  if (Object.hasOwn(profile, 'sourcePath')) throw new Error('INVALID_PROFILE: sourcePath');
  if (typeof profile.id !== 'string') throw new Error('INVALID_PROFILE: id');
  if (typeof profile.checkerId !== 'string') throw new Error('INVALID_PROFILE: checkerId');
  for (const field of ['digest', 'checkerDigest', 'oracleDigest', 'toolchainDigest', 'environmentDigest'] as const)
    if (!sha(profile[field])) throw new Error('INVALID_PROFILE: ' + field);
  if (!Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs < 1 || profile.timeoutMs > 35 * 60_000)
    throw new Error('INVALID_PROFILE: timeoutMs');
  if (!Number.isSafeInteger(profile.maxOutputBytes) || profile.maxOutputBytes < 1 || profile.maxOutputBytes > OUTPUT_CAP)
    throw new Error('INVALID_PROFILE: maxOutputBytes');
  if (profile.kind === 'command') {
    validateCommandProfile(profile);
    const pin = await digest(commandConfig(profile));
    for (const field of ['checkerDigest', 'toolchainDigest', 'oracleDigest', 'environmentDigest'] as const)
      if (profile[field] !== pin) throw new Error('INVALID_COMMAND_PROFILE: ' + field);
  } else if (profile.kind !== undefined) throw new Error('INVALID_PROFILE: kind');
  if (profile.kind !== 'command' && profile.checkerId !== 'dispatch-lab') {
    if (!profile.executable || !isAbsolute(profile.executable)) throw new Error('INVALID_PROFILE: executable');
    if (!Array.isArray(profile.argv) || profile.argv.some(arg => typeof arg !== 'string')) throw new Error('INVALID_PROFILE: argv');
    if (!profile.checkerFile || !isAbsolute(profile.checkerFile)) throw new Error('INVALID_PROFILE: checkerFile');
    if (!profile.oracleFile || !isAbsolute(profile.oracleFile)) throw new Error('INVALID_PROFILE: oracleFile');
    if (profile.successOutcome !== undefined && !['PASS', 'MATCH'].includes(profile.successOutcome))
      throw new Error('INVALID_PROFILE: successOutcome');
  }
  if (!profile.toolchainFile || !isAbsolute(profile.toolchainFile)) throw new Error('INVALID_PROFILE: toolchainFile');
  if (profile.kind !== 'command' && profile.checkerId !== 'dispatch-lab' && profile.executable && profile.checkerFile &&
    (![profile.toolchainFile, profile.checkerFile].map(value => resolve(value!)).includes(resolve(profile.executable)) ||
      resolve(profile.executable) !== resolve(profile.checkerFile) && !profile.argv!.includes(profile.checkerFile))) throw new Error('UNPINNED_EXECUTABLE');
  if (profile.checkerId === 'dispatch-lab' && (profile.executable !== process.execPath ||
    profile.checkerFile !== undefined && !isAbsolute(profile.checkerFile) ||
    JSON.stringify(profile.argv) !== JSON.stringify(dispatchArgv))) throw new Error('INVALID_PROFILE_ARGV');
  if (profile.checkerId === 'dispatch-lab') {
    if (!profile.cases || !Object.keys(profile.cases).length) throw new Error('INVALID_PROFILE: cases');
    for (const [caseId, required] of Object.entries(requiredDispatchCases)) {
      if (stableJson(profile.cases[caseId]) !== stableJson(required)) throw new Error('INVALID_PROFILE_CASE');
    }
    if (Object.keys(profile.cases).some(caseId => !Object.hasOwn(requiredDispatchCases, caseId))) throw new Error('INVALID_PROFILE_CASE');
    const allowedChoices = ['2:500:1000', '2:1000:2000'];
    for (const [caseId, config] of Object.entries(profile.cases)) {
      if (!/^[a-z0-9-]{1,64}$/.test(caseId) || !config || !config.rows ||
        Object.keys(config.rows).sort().join(',') !== Object.keys(requiredDispatchCases[caseId].rows).sort().join(',') ||
        !Object.values(config.rows).every(validRow)) throw new Error('INVALID_PROFILE_CASE');
      if ((caseId === 'j-common') !== !!config.epsilonChoices) throw new Error('INVALID_PROFILE_CASE');
      if (config.epsilonChoices && (config.epsilonChoices.length !== 2 ||
        config.epsilonChoices.map(value => `${value.retry_limit}:${value.timeout_ms}:${value.output}`).sort().join(',') !== allowedChoices.sort().join(','))) throw new Error('INVALID_PROFILE_CASE');
    }
  }
  const { digest: declared, ...input } = profile;
  if (await digest(input) !== declared) throw new Error('PROFILE_DIGEST_MISMATCH');
  if (profile.kind === 'command') await commandExecutableAvailable(profile);
  Object.defineProperty(profile, 'sourcePath', { value: path, enumerable: false });
  return profile;
}

/** Rechecked for every claimed job; command profiles require an executable, not matching host bytes. */
export async function verifyLocalProfile(profile: LocalProfile): Promise<void> {
  if (!profile.toolchainFile) throw new Error('TOOLCHAIN_FILE_MISSING');
  if (profile.kind === 'command') {
    await commandExecutableAvailable(profile);
    return;
  }
  if (await digest(localEnvironment()) !== profile.environmentDigest) throw new Error('ENVIRONMENT_DIGEST_MISMATCH');
  if (profile.checkerId === 'dispatch-lab' && resolve(profile.toolchainFile) !== resolve(process.execPath)) throw new Error('TOOLCHAIN_PATH_MISMATCH');
  if (await fileDigest(profile.toolchainFile) !== profile.toolchainDigest) throw new Error('TOOLCHAIN_DIGEST_MISMATCH');
  if (profile.checkerId === 'dispatch-lab') {
    if (await fileDigest(profile.checkerFile ?? fileURLToPath(import.meta.url)) !== profile.checkerDigest) throw new Error('CHECKER_DIGEST_MISMATCH');
  } else if (await fileDigest(profile.checkerFile!) !== profile.checkerDigest ||
    await fileDigest(profile.oracleFile!) !== profile.oracleDigest) throw new Error('LOCAL_PIN_MISMATCH');
  if (profile.checkerId === 'dispatch-lab' && (!profile.cases ||
    await digest(profile.cases) !== profile.oracleDigest)) throw new Error('ORACLE_DIGEST_MISMATCH');
}

export function checkProfile(job: Job, profile: LocalProfile): void {
  if (profile.digest !== job.profileDigest || profile.checkerId !== job.checkerId ||
    profile.checkerDigest !== job.checkerDigest || profile.oracleDigest !== job.oracleDigest ||
    profile.toolchainDigest !== job.toolchainDigest || profile.environmentDigest !== job.environmentDigest ||
    profile.timeoutMs !== job.timeoutMs || profile.maxOutputBytes !== job.maxOutputBytes) throw new Error('PROFILE_PIN_MISMATCH');
}

function rowValues(text: string): Record<string, ExpectedRow> {
  if (text.includes('\r')) throw new Error('INVALID_TSV');
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split(/\r?\n/);
  if (lines.shift() !== 'family\tretry_limit\ttimeout_ms') throw new Error('INVALID_TSV');
  const rows: Record<string, ExpectedRow> = {};
  for (const line of lines) {
    const cells = line.split('\t');
    if (cells.length !== 3 || !/^[a-z]+$/.test(cells[0]) || Object.hasOwn(rows, cells[0]) ||
      !/^\d+$/.test(cells[1]) || !/^\d+$/.test(cells[2])) throw new Error('INVALID_TSV');
    const retry_limit = Number(cells[1]);
    const timeout_ms = Number(cells[2]);
    if (retry_limit < 1 || retry_limit > 5 || timeout_ms < 250 || timeout_ms > 2000) throw new Error('INVALID_TSV');
    rows[cells[0]] = { retry_limit, timeout_ms, output: 0 };
  }
  return rows;
}

const families = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] as const;
const sameRow = (a: ExpectedRow, b: ExpectedRow) => a.retry_limit === b.retry_limit && a.timeout_ms === b.timeout_ms && a.output === b.output;
const candidateCode = `import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(process.argv[1]).href);
if (typeof mod.attemptBudget !== 'function') throw new Error('missing attemptBudget');
const values = {};
for (const family of {families}) values[family] = await mod.attemptBudget(family);
process.stdout.write(JSON.stringify(values));`;
/** Exported so the owner fixture can pin the exact child argv in its profile. */
export const dispatchArgv = ['--input-type=module', '-e', candidateCode, '{repo}/dispatch.mjs'];

export async function pinnedCheck(profile: LocalProfile, job: Job, repo: string, unit = 'all'): Promise<{ outcome: CheckOutcome; log: string; score: { matched: number; total: number } | null }> {
  checkProfile(job, profile);
  if (profile.kind === 'command') {
    if (resolve(profile.executable!).startsWith(resolve(repo) + sep)) throw new Error('CHECKER_IN_CANDIDATE');
    const env: NodeJS.ProcessEnv = {};
    for (const name of profile.env!) if (process.env[name] !== undefined) env[name] = process.env[name];
    const values = [...new Set(profile.env!.map(name => process.env[name]).filter((value): value is string => !!value))]
      .sort((a, b) => b.length - a.length);
    const hostLine = await commandHostLine(profile);
    const result = await command(profile.executable!, profile.argv!, repo, profile.timeoutSeconds! * 1000,
      env, { outputCap: profile.outputCap!, tail: true, redact: values });
    const output = result.outputTail ?? '';
    const prefix = `${hostLine}exit=${result.code}${result.timedOut ? ' timeout' : ''}\n`;
    const remaining = profile.outputCap! - Buffer.byteLength(prefix);
    const bytes = Buffer.from(output);
    return { outcome: result.timedOut || result.code !== 0 ? 'FAIL' : 'PASS',
      log: prefix + bytes.subarray(Math.max(0, bytes.length - remaining)).toString('utf8'), score: null };
  }
  if (profile.checkerId === 'dispatch-lab') {
    const caseId = (job as Job & { caseId?: string }).caseId;
    const expected = caseId && profile.cases?.[caseId];
    if (!expected) throw new Error('UNKNOWN_CASE_ID');
    const expectedFamilies = Object.keys(expected.rows);
    if (profile.checkerFile) {
      if (resolve(profile.checkerFile).startsWith(resolve(repo) + sep)) throw new Error('CHECKER_IN_CANDIDATE');
      const result = await command(process.execPath, [profile.checkerFile, '--repo', repo, '--unit', unit, '--case', caseId!],
        repo, profile.timeoutMs, childEnvironment());
      if (result.timedOut) return { outcome: 'TIMEOUT', log: result.stderr, score: null };
      let value: { outcome: CheckOutcome; log: string; score: { matched: number; total: number } | null };
      try { value = JSON.parse(result.stdout.trim()) as typeof value; }
      catch { return { outcome: 'FAIL', log: 'Checker output was not JSON: ' + result.stderr, score: null }; }
      if (!['PASS', 'FAIL'].includes(value.outcome) || typeof value.log !== 'string' ||
        (value.outcome === 'PASS') !== (result.code === 0)) return { outcome: 'FAIL', log: 'Checker protocol mismatch', score: null };
      return value;
    }
    try {
      if (!(await lstat(resolve(repo, 'families.tsv'))).isFile() || !(await lstat(resolve(repo, 'dispatch.mjs'))).isFile())
        return { outcome: 'FAIL', log: 'Candidate files must be regular files', score: null };
    } catch { return { outcome: 'FAIL', log: 'Candidate files missing', score: null }; }
    let rows: Record<string, ExpectedRow>;
    try { rows = rowValues(await readFile(resolve(repo, 'families.tsv'), 'utf8')); }
    catch { return { outcome: 'FAIL', log: 'Invalid or missing families.tsv', score: null }; }
    if (Object.keys(rows).sort().join(',') !== expectedFamilies.sort().join(',')) return { outcome: 'FAIL', log: 'Missing or unexpected family', score: null };
    const argv = dispatchArgv.map(arg => arg === '{repo}/dispatch.mjs' ? resolve(repo, 'dispatch.mjs') :
      arg.replace('{families}', JSON.stringify(expectedFamilies)));
    const result = await command(process.execPath, argv,
      repo, profile.timeoutMs, childEnvironment());
    if (result.timedOut) return { outcome: 'TIMEOUT', log: result.stderr, score: null };
    if (result.code !== 0) return { outcome: 'FAIL', log: result.stderr, score: null };
    let outputs: Record<string, unknown>;
    try { outputs = JSON.parse(result.stdout) as Record<string, unknown>; }
    catch { return { outcome: 'FAIL', log: 'Candidate output was not JSON', score: null }; }
    for (const family of expectedFamilies) {
      const actual = { ...rows[family], output: outputs[family] } as ExpectedRow;
      if (!Number.isSafeInteger(outputs[family])) return { outcome: 'FAIL', log: 'Noninteger output: ' + family, score: null };
      if (family === 'epsilon' && expected.epsilonChoices?.length) {
        if (!expected.epsilonChoices.some(choice => sameRow(choice, actual))) return { outcome: 'FAIL', log: 'Epsilon tuple mismatch', score: null };
      } else if (!sameRow(expected.rows[family], actual)) {
        return { outcome: 'FAIL', log: 'Mismatch: ' + family, score: null };
      }
    }
    const score = expected.epsilonChoices?.length ? { matched: rows.epsilon.timeout_ms >= 1000 ? 4 : 2, total: 4 } : null;
    return { outcome: 'PASS', log: 'Exact acceptance case passed: ' + caseId, score };
  }
  const executable = profile.executable!;
  if (resolve(executable).startsWith(resolve(repo) + sep)) throw new Error('CHECKER_IN_CANDIDATE');
  const argv = profile.argv!.map(arg => arg.replaceAll('{repo}', repo).replaceAll('{unit}', unit));
  const result = await command(executable, argv, repo, profile.timeoutMs, childEnvironment());
  return { outcome: result.timedOut ? 'TIMEOUT' : result.code === 0 ? profile.successOutcome ?? 'PASS' : 'FAIL',
    log: (result.stdout + result.stderr).slice(0, OUTPUT_CAP), score: null };
}
