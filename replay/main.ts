import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseReplayJsonl } from './schema.ts';
import { buildReplayReport, buildGithubBaseline, renderGithubBaselineTable, renderHtml, unavailableReport } from './report.ts';

function usage(): never {
  throw new Error('Usage: replay validate --input PATH | replay compare --input PATH --output PATH [--workers N] [--checkers N] | replay compare --explain-missing --output PATH | replay baseline --input PATH');
}
function args(argv: string[]): { command: string; values: Map<string, string | true> } {
  const command = argv[0];
  const values = new Map<string, string | true>();
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) usage();
    if (arg === '--explain-missing') { values.set(arg, true); continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) usage();
    values.set(arg, value);
  }
  return { command, values };
}
function required(values: Map<string, string | true>, key: string): string {
  const value = values.get(key);
  if (typeof value !== 'string') usage();
  return value;
}
function capacity(values: Map<string, string | true>, key: string, fallback: number): number {
  const value = values.get(key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 128) throw new Error(`${key} must be an integer from 1 to 128`);
  return parsed;
}
async function writeReport(path: string, report: ReturnType<typeof unavailableReport>): Promise<void> {
  const content = extname(path).toLowerCase() === '.html' ? renderHtml(report) : `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(path, content, 'utf8');
}

async function main(): Promise<void> {
  const { command, values } = args(process.argv.slice(2));
  if (command === 'validate') {
    const data = parseReplayJsonl(await readFile(required(values, '--input'), 'utf8'));
    console.log(`Valid provenance-bearing historical export: ${data.header.exportId} (${data.events.length} events, ${data.header.selected.taskIds.length} selected tasks)`);
    console.log('Owner release reference is attested provenance; the underlying private source was not independently verified.');
    return;
  }
  if (command === 'baseline') {
    const data = parseReplayJsonl(await readFile(required(values, '--input'), 'utf8'));
    console.log(renderGithubBaselineTable(buildGithubBaseline(data), { cohortId: data.header.selected.cohortId, window: data.header.selected.window }));
    return;
  }
  if (command !== 'compare') usage();
  const output = required(values, '--output');
  if (values.has('--explain-missing')) {
    if (values.has('--input')) throw new Error('--explain-missing cannot be combined with --input');
    const report = unavailableReport();
    await writeReport(output, report);
    console.log(`Historical comparison unavailable; report written to ${output}`);
    return;
  }
  const data = parseReplayJsonl(await readFile(required(values, '--input'), 'utf8'));
  const report = buildReplayReport(data, {
    workerCapacity: capacity(values, '--workers', 2),
    checkerCapacity: capacity(values, '--checkers', 1),
  });
  await writeReport(output, report);
  console.log(`Measured baseline and bounded simulation report written to ${output}; no causal speedup claim emitted.`);
}

main().catch(error => {
  console.error(`replay: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
