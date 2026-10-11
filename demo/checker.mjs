import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Reviewed constants are outside every candidate fork. A case revision changes
// the trusted profile digest; candidate data never supplies expected values.
const a1 = { retry_limit: 1, timeout_ms: 1000, output: 1000 };
const a2 = { retry_limit: 2, timeout_ms: 1000, output: 2000 };
const a3 = { retry_limit: 3, timeout_ms: 1000, output: 3000 };
const a4 = { retry_limit: 4, timeout_ms: 1000, output: 4000 };
const b2 = { retry_limit: 2, timeout_ms: 1000, output: 2000 };
const b3 = { retry_limit: 3, timeout_ms: 1000, output: 3000 };
const g3 = { retry_limit: 3, timeout_ms: 1000, output: 3000 };
const g4 = { retry_limit: 4, timeout_ms: 1250, output: 5000 };
const g5 = { retry_limit: 5, timeout_ms: 1250, output: 6250 };
const d4 = { retry_limit: 4, timeout_ms: 1000, output: 4000 };
const d5 = { retry_limit: 5, timeout_ms: 1000, output: 5000 };
const de = { retry_limit: 4, timeout_ms: 1500, output: 6000 };
const e1 = { retry_limit: 1, timeout_ms: 500, output: 500 };
const el = { retry_limit: 2, timeout_ms: 500, output: 1000 };
const eh = { retry_limit: 2, timeout_ms: 1000, output: 2000 };

export const cases = Object.freeze({
  seed: { rows: { alpha: a1, beta: b2, gamma: g3, delta: d4, epsilon: e1 } },
  'a-only': { rows: { alpha: a2, beta: b2, gamma: g3, delta: d4, epsilon: e1 } },
  'b-only': { rows: { alpha: a1, beta: b2, gamma: g3, delta: d4, epsilon: e1 } },
  'c-only': { rows: { alpha: a1, beta: b2, gamma: g3, delta: d5, epsilon: e1 } },
  'a-b': { rows: { alpha: a2, beta: b2, gamma: g3, delta: d4, epsilon: e1 } },
  'a-c-survivors': { rows: { alpha: a2, beta: b2, gamma: g3, delta: d5, epsilon: e1 } },
  'b-c': { rows: { alpha: a1, beta: b2, gamma: g3, delta: d5, epsilon: e1 } },
  'a-b-c': { rows: { alpha: a2, beta: b2, gamma: g3, delta: d5, epsilon: e1 } },
  'b-repaired': { rows: { alpha: a2, beta: b2, gamma: g4, delta: d5, epsilon: e1 } },
  'd-only': { rows: { alpha: a3, beta: b2, gamma: g4, delta: d5, epsilon: e1 } },
  'e-only': { rows: { alpha: a2, beta: b2, gamma: g4, delta: de, epsilon: e1 } },
  'd-e': { rows: { alpha: a3, beta: b2, gamma: g4, delta: de, epsilon: e1 } },
  'h-only': { rows: { alpha: a4, beta: b2, gamma: g4, delta: de, epsilon: e1 } },
  'i-only': { rows: { alpha: a3, beta: b3, gamma: g4, delta: de, epsilon: e1 } },
  'j-common': { rows: { alpha: a3, beta: b3, gamma: g4, delta: de, epsilon: el }, epsilonChoices: [el, eh] },
  'aw-only': { rows: { alpha: a3, beta: b3, gamma: g5, delta: de, epsilon: eh } },
});

const families = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
const same = (a, b) => a.retry_limit === b.retry_limit && a.timeout_ms === b.timeout_ms && a.output === b.output;

function parseTable(text) {
  if (text.includes('\r')) throw new Error('INVALID_TSV');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (lines.shift() !== 'family\tretry_limit\ttimeout_ms' || lines.length !== 5) throw new Error('INVALID_TSV');
  const rows = {};
  for (const line of lines) {
    const cells = line.split('\t');
    if (cells.length !== 3 || !families.includes(cells[0]) || Object.hasOwn(rows, cells[0]) ||
      !/^\d+$/.test(cells[1]) || !/^\d+$/.test(cells[2])) throw new Error('INVALID_TSV');
    const retry_limit = Number(cells[1]);
    const timeout_ms = Number(cells[2]);
    if (!Number.isSafeInteger(retry_limit) || retry_limit < 1 || retry_limit > 5 ||
      !Number.isSafeInteger(timeout_ms) || timeout_ms < 250 || timeout_ms > 2000) throw new Error('INVALID_TSV');
    rows[cells[0]] = { retry_limit, timeout_ms };
  }
  if (families.some(family => !rows[family])) throw new Error('INVALID_TSV');
  return rows;
}

function invoke(file, repo) {
  const code = `import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(process.argv[1]).href);
if (typeof mod.attemptBudget !== 'function') throw new Error('missing attemptBudget');
const values = {};
for (const family of ['alpha','beta','gamma','delta','epsilon']) values[family] = await mod.attemptBudget(family);
process.stdout.write(JSON.stringify(values));`;
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, file], {
      cwd: repo, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 16384) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 16384) child.kill('SIGKILL'); });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolveResult({ code, stdout, stderr }); });
  });
}

export async function check(repo, caseId, unit = 'all') {
  const expected = cases[caseId];
  if (!expected || unit !== 'all') throw new Error('UNKNOWN_CASE_OR_UNIT');
  try {
    const table = resolve(repo, 'families.tsv');
    const executable = resolve(repo, 'dispatch.mjs');
    if (!(await lstat(table)).isFile() || !(await lstat(executable)).isFile()) throw new Error('Candidate files must be regular files');
    const rows = parseTable(await readFile(table, 'utf8'));
    const result = await invoke(executable, repo);
    if (result.code !== 0) throw new Error('Candidate executable failed: ' + result.stderr.slice(0, 1000));
    const outputs = JSON.parse(result.stdout);
    for (const family of families) {
      if (!Number.isSafeInteger(outputs[family])) throw new Error('Noninteger output: ' + family);
      const actual = { ...rows[family], output: outputs[family] };
      if (family === 'epsilon' && expected.epsilonChoices) {
        if (!expected.epsilonChoices.some(choice => same(choice, actual))) throw new Error('Epsilon tuple mismatch');
      } else if (!same(expected.rows[family], actual)) throw new Error(`Mismatch: ${family} (${actual.output} versus ${expected.rows[family].output})`);
    }
    const score = expected.epsilonChoices ? { matched: [250, 500, 750, 1000].filter(ms => ms <= rows.epsilon.timeout_ms).length, total: 4 } : null;
    return { outcome: 'PASS', log: `Exact acceptance case passed: ${caseId}`, score };
  } catch (error) {
    return { outcome: 'FAIL', log: String(error instanceof Error ? error.message : error), score: null };
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const values = new Map();
  for (let i = 2; i < process.argv.length; i += 2) values.set(process.argv[i], process.argv[i + 1]);
  if (!values.get('--repo') || !values.get('--case') || values.get('--unit') !== 'all') {
    process.stderr.write('Usage: node demo/checker.mjs --repo PATH --unit all --case CASE_ID\n');
    process.exitCode = 2;
  } else {
    check(values.get('--repo'), values.get('--case'), values.get('--unit')).then(result => {
      process.stdout.write(JSON.stringify(result) + '\n');
      if (result.outcome !== 'PASS') process.exitCode = 1;
    }).catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 2; });
  }
}
