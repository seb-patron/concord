import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ConcordError } from './client.ts';

/** Reads launcher evidence; the validated SHA is authoritative. */
export async function readAwRun(runDir: string): Promise<{ source: string; commit: string; base?: string; intentKey: string; intent: string; allowedFiles: string }> {
  const directory = resolve(runDir);
  const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8')) as Record<string, unknown>;
  const spec = await readFile(join(directory, 'work-spec.md'), 'utf8');
  const intent = /^\s*Outcome:\s*(.+)$/m.exec(spec)?.[1]?.trim();
  const commit = status.validated_sha;
  const source = status.worktree;
  const intentKey = status.job_id ?? status.attempt_id;
  const state = await readFile(join(directory, 'run-state.env'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const recordedBase = status.base_sha ?? status.base_oid ?? status.base_commit ?? status.base ??
    status.parent_sha ?? status.parent_oid ?? status.parent_commit ?? status.parent ??
    /^(?:BASE_SHA|BASE_OID|PARENT_SHA|PARENT_OID)=['"]?([a-f0-9]{40})['"]?$/im.exec(state)?.[1];
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(commit) ||
      typeof source !== 'string' || !source || typeof intentKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(intentKey) || !intent) {
    throw new ConcordError('AW run requires validated_sha, worktree, job_id, and a Goal Outcome', 'usage');
  }
  if (recordedBase !== undefined && (typeof recordedBase !== 'string' || !/^[a-f0-9]{40}$/i.test(recordedBase)))
    throw new ConcordError('AW run recorded base is malformed', 'usage');
  return { source, commit, ...(recordedBase ? { base: recordedBase } : {}), intentKey, intent, allowedFiles: join(directory, 'allowed-files.txt') };
}
