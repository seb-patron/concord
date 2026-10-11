import { lstat, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Job, CheckOutcome } from '../src/contracts';
import { digest } from '../src/http';
import { childEnvironment, command, OUTPUT_CAP } from './git';

export type ExpectedRow = { retry_limit: number; timeout_ms: number; output: number };
export type LocalProfile = {
  id: string; digest: string; checkerId: string; checkerDigest: string;
  oracleDigest: string; toolchainDigest: string; environmentDigest: string;
  timeoutMs: number; maxOutputBytes: number;
  executable?: string; argv?: string[]; successOutcome?: 'PASS' | 'MATCH'; checkerFile?: string; toolchainFile?: string; oracleFile?: string;
  cases?: Record<string, { rows: Record<string, ExpectedRow>; epsilonChoices?: ExpectedRow[] }>;
  /** Added by the loader; never included in the content digest. */
  sourcePath?: string;
};
const sha = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const fileDigest = async (path: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(resolve(path))) hash.update(chunk);
  return 'sha256:' + hash.digest('hex');
};
export const localEnvironment = () => ({ platform: process.platform, arch: process.arch, node: process.version });
const validRow = (value: unknown): value is ExpectedRow => !!value && typeof value === 'object' &&
  Number.isSafeInteger((value as ExpectedRow).retry_limit) && (value as ExpectedRow).retry_limit >= 1 && (value as ExpectedRow).retry_limit <= 5 &&
  Number.isSafeInteger((value as ExpectedRow).timeout_ms) && (value as ExpectedRow).timeout_ms >= 250 && (value as ExpectedRow).timeout_ms <= 2000 &&
  Number.isSafeInteger((value as ExpectedRow).output);

export async function loadProfile(filename: string): Promise<LocalProfile> {
  if (!isAbsolute(filename)) throw new Error('PROFILE_ABSOLUTE_PATH_REQUIRED');
  const path = resolve(filename);
  const profile = JSON.parse(await readFile(path, 'utf8')) as LocalProfile;
  if (!profile || Object.hasOwn(profile, 'sourcePath') || typeof profile.id !== 'string' || typeof profile.checkerId !== 'string' ||
    ![profile.digest, profile.checkerDigest, profile.oracleDigest, profile.toolchainDigest, profile.environmentDigest].every(sha) ||
    !Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs < 1 || profile.timeoutMs > 35 * 60_000 ||
    !Number.isSafeInteger(profile.maxOutputBytes) || profile.maxOutputBytes < 1 || profile.maxOutputBytes > OUTPUT_CAP) throw new Error('INVALID_PROFILE');
  if (profile.checkerId !== 'dispatch-lab' && (!profile.executable || !isAbsolute(profile.executable) ||
    !Array.isArray(profile.argv) || profile.argv.some(arg => typeof arg !== 'string') ||
    !profile.checkerFile || !isAbsolute(profile.checkerFile) || !profile.oracleFile || !isAbsolute(profile.oracleFile) ||
    profile.successOutcome !== undefined && !['PASS', 'MATCH'].includes(profile.successOutcome))) throw new Error('INVALID_PROFILE');
  if (!profile.toolchainFile || !isAbsolute(profile.toolchainFile)) throw new Error('INVALID_PROFILE');
  if (profile.checkerId !== 'dispatch-lab' && profile.executable && profile.checkerFile &&
    (![profile.toolchainFile, profile.checkerFile].map(value => resolve(value!)).includes(resolve(profile.executable)) ||
      resolve(profile.executable) !== resolve(profile.checkerFile) && !profile.argv!.includes(profile.checkerFile))) throw new Error('UNPINNED_EXECUTABLE');
  if (profile.checkerId === 'dispatch-lab' && (profile.executable !== process.execPath ||
    JSON.stringify(profile.argv) !== JSON.stringify(dispatchArgv))) throw new Error('INVALID_PROFILE_ARGV');
  if (profile.checkerId === 'dispatch-lab') {
    if (!profile.cases || !Object.keys(profile.cases).length) throw new Error('INVALID_PROFILE');
    const allowedChoices = ['2:500:1000', '2:1000:2000'];
    for (const [caseId, config] of Object.entries(profile.cases)) {
      if (!/^[a-z0-9-]{1,64}$/.test(caseId) || !config || !config.rows ||
        Object.keys(config.rows).sort().join(',') !== 'alpha,beta,delta,epsilon,gamma' ||
        !Object.values(config.rows).every(validRow)) throw new Error('INVALID_PROFILE_CASE');
      if ((caseId === 'j-common') !== !!config.epsilonChoices) throw new Error('INVALID_PROFILE_CASE');
      if (config.epsilonChoices && (config.epsilonChoices.length !== 2 ||
        config.epsilonChoices.map(value => `${value.retry_limit}:${value.timeout_ms}:${value.output}`).sort().join(',') !== allowedChoices.sort().join(','))) throw new Error('INVALID_PROFILE_CASE');
    }
  }
  const { digest: declared, ...input } = profile;
  if (await digest(input) !== declared) throw new Error('PROFILE_DIGEST_MISMATCH');
  Object.defineProperty(profile, 'sourcePath', { value: path, enumerable: false });
  return profile;
}

/** Rechecked for every claimed job so a missing or changed local binary is reported as ENV_ERROR. */
export async function verifyLocalProfile(profile: LocalProfile): Promise<void> {
  if (!profile.toolchainFile) throw new Error('TOOLCHAIN_FILE_MISSING');
  if (await digest(localEnvironment()) !== profile.environmentDigest) throw new Error('ENVIRONMENT_DIGEST_MISMATCH');
  if (profile.checkerId === 'dispatch-lab' && resolve(profile.toolchainFile) !== resolve(process.execPath)) throw new Error('TOOLCHAIN_PATH_MISMATCH');
  if (await fileDigest(profile.toolchainFile) !== profile.toolchainDigest) throw new Error('TOOLCHAIN_DIGEST_MISMATCH');
  if (profile.checkerId === 'dispatch-lab') {
    if (await fileDigest(fileURLToPath(import.meta.url)) !== profile.checkerDigest) throw new Error('CHECKER_DIGEST_MISMATCH');
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
for (const family of ['alpha','beta','gamma','delta','epsilon']) values[family] = await mod.attemptBudget(family);
process.stdout.write(JSON.stringify(values));`;
/** Exported so the owner fixture can pin the exact child argv in its profile. */
export const dispatchArgv = ['--input-type=module', '-e', candidateCode, '{repo}/dispatch.mjs'];

export async function pinnedCheck(profile: LocalProfile, job: Job, repo: string, unit = 'all'): Promise<{ outcome: CheckOutcome; log: string; score: { matched: number; total: number } | null }> {
  checkProfile(job, profile);
  if (profile.checkerId === 'dispatch-lab') {
    const caseId = (job as Job & { caseId?: string }).caseId;
    const expected = caseId && profile.cases?.[caseId];
    if (!expected || families.some(family => !expected.rows[family]) ||
      Object.keys(expected.rows).length !== families.length) throw new Error('UNKNOWN_CASE_ID');
    try {
      if (!(await lstat(resolve(repo, 'families.tsv'))).isFile() || !(await lstat(resolve(repo, 'dispatch.mjs'))).isFile())
        return { outcome: 'FAIL', log: 'Candidate files must be regular files', score: null };
    } catch { return { outcome: 'FAIL', log: 'Candidate files missing', score: null }; }
    let rows: Record<string, ExpectedRow>;
    try { rows = rowValues(await readFile(resolve(repo, 'families.tsv'), 'utf8')); }
    catch { return { outcome: 'FAIL', log: 'Invalid or missing families.tsv', score: null }; }
    if (Object.keys(rows).length !== families.length || families.some(family => !rows[family])) return { outcome: 'FAIL', log: 'Missing required family', score: null };
    const argv = dispatchArgv.map(arg => arg === '{repo}/dispatch.mjs' ? resolve(repo, 'dispatch.mjs') : arg);
    const result = await command(process.execPath, argv,
      repo, profile.timeoutMs, childEnvironment());
    if (result.timedOut) return { outcome: 'TIMEOUT', log: result.stderr, score: null };
    if (result.code !== 0) return { outcome: 'FAIL', log: result.stderr, score: null };
    let outputs: Record<string, unknown>;
    try { outputs = JSON.parse(result.stdout) as Record<string, unknown>; }
    catch { return { outcome: 'FAIL', log: 'Candidate output was not JSON', score: null }; }
    for (const family of families) {
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
