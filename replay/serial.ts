import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ReplayManifest } from './manifest.ts';

export interface SerialChangeResult {
  id: string;
  label: string;
  order: number;
  mergedAt: string | null;
  conflict: boolean;
  conflictFiles: string[];
  usedResolvedHead: boolean;
  chargedMinutes: number;
  validation: { exitCode: number; durationMs: number } | null;
  mainRed: boolean;
}

export interface SerialResult {
  schemaVersion: 1;
  arm: 'pr';
  batch: string;
  startCommit: string;
  validationCommand: string;
  startedAt: string;
  finishedAt: string;
  changes: SerialChangeResult[];
  totals: {
    conflicts: number;
    mainRedMerges: number;
    workerRunsCharged: number;
    freshReviewsCharged: number;
    chargedMinutes: number;
    timeToGreenMs: number | null;
  };
}

interface RunResult { code: number; stdout: string; stderr: string; durationMs: number }

async function run(command: string, args: string[], cwd: string, timeoutMs?: number): Promise<RunResult> {
  const started = Date.now();
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: timeoutMs !== undefined });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const collect = (parts: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size <= 4 * 1024 * 1024) parts.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(output, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(errors, chunk));
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { child.kill('SIGKILL'); }
      }
    }, timeoutMs);
    child.once('error', error => { if (timer) clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      accept({ code: timedOut ? 124 : code ?? (signal ? 128 : 1), stdout: Buffer.concat(output).toString('utf8'),
        stderr: Buffer.concat(errors).toString('utf8'), durationMs: Date.now() - started });
    });
  });
}

async function git(cwd: string, args: string[]): Promise<RunResult> {
  const result = await run('git', args, cwd);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  return result;
}

function conflictPaths(output: string): string[] {
  const entries = output.split('\0');
  // With -z and --name-only, merge-tree emits tree OID, then conflicted paths.
  return [...new Set(entries.slice(1).filter(Boolean))].sort();
}

async function inspectMerge(cwd: string, head: string): Promise<{ conflict: boolean; files: string[] }> {
  const result = await run('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', 'HEAD', head], cwd);
  if (result.code === 0) return { conflict: false, files: [] };
  if (result.code === 1) return { conflict: true, files: conflictPaths(result.stdout) };
  throw new Error(`git merge-tree failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
}

export async function replaySerial(manifest: ReplayManifest, repo: string, options: { validationTimeoutSeconds?: number; keep?: boolean } = {}): Promise<SerialResult> {
  const timeoutSeconds = options.validationTimeoutSeconds ?? 3600;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) throw new Error('--validation-timeout must be a positive integer in seconds');
  const startedAt = new Date().toISOString();
  const scratch = await mkdtemp(join(tmpdir(), 'concord-replay-'));
  const clone = join(scratch, 'repo');
  let succeeded = false;
  try {
    await git(scratch, ['clone', '--no-hardlinks', '--no-checkout', '--', resolve(repo), clone]);
    await git(clone, ['checkout', '--detach', manifest.startCommit]);
    const changes: SerialChangeResult[] = [];
    let firstMergeStart: number | null = null;
    for (const change of [...manifest.changes].sort((a, b) => a.order - b.order)) {
      if (firstMergeStart === null) firstMergeStart = Date.now();
      const original = await inspectMerge(clone, change.head);
      let mergeHead = change.head;
      let usedResolvedHead = false;
      if (original.conflict && change.charge) {
        const resolved = await inspectMerge(clone, change.charge.resolvedHead);
        if (!resolved.conflict) {
          mergeHead = change.charge.resolvedHead;
          usedResolvedHead = true;
        }
      }
      const entry: SerialChangeResult = {
        id: change.id, label: change.label, order: change.order, mergedAt: null,
        conflict: original.conflict, conflictFiles: original.files, usedResolvedHead,
        chargedMinutes: usedResolvedHead ? change.charge!.rebaseRunMinutes + change.charge!.reviewMinutes : 0,
        validation: null, mainRed: false,
      };
      if (original.conflict && !usedResolvedHead) { changes.push(entry); continue; }
      await git(clone, ['-c', 'user.name=Replay', '-c', 'user.email=replay@example.invalid', 'merge', '--no-ff', '--no-edit', mergeHead]);
      entry.mergedAt = new Date().toISOString();
      const validation = await run('sh', ['-c', manifest.validationCommand], clone, timeoutSeconds * 1000);
      entry.validation = { exitCode: validation.code, durationMs: validation.durationMs };
      entry.mainRed = validation.code !== 0;
      changes.push(entry);
    }
    const finishedAt = new Date().toISOString();
    const charged = changes.filter(change => change.usedResolvedHead);
    const green = changes.every(change => change.mergedAt !== null) && changes.at(-1)?.validation?.exitCode === 0;
    const result: SerialResult = {
      schemaVersion: 1, arm: 'pr', batch: manifest.batch, startCommit: manifest.startCommit,
      validationCommand: manifest.validationCommand, startedAt, finishedAt, changes,
      totals: {
        conflicts: changes.filter(change => change.conflict).length,
        mainRedMerges: changes.filter(change => change.mainRed).length,
        workerRunsCharged: charged.length, freshReviewsCharged: charged.length,
        chargedMinutes: changes.reduce((sum, change) => sum + change.chargedMinutes, 0),
        timeToGreenMs: green && firstMergeStart !== null ? Date.parse(finishedAt) - firstMergeStart : null,
      },
    };
    succeeded = true;
    if (options.keep) console.log(`Scratch clone kept at ${clone}`);
    return result;
  } finally {
    if (!options.keep || !succeeded) await rm(scratch, { recursive: true, force: true });
  }
}
