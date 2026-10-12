import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CandidateInput, CheckOutcome, Job, JobResult, StackResult } from '../src/contracts';
import { digest } from '../src/http';
import { compareKeys } from '../src/verdicts/manifest';
import { childEnvironment, command, conditionalPush, fetchOid, git, gitCredentialEnvironment, initWorktree, isAncestor, refOid, temporaryWork, treeOid, withJobDeadline, OUTPUT_CAP } from './git';
import { inspectUnits, mergeTsv } from './units';
import { declaredGenerators, generatorForFile, tableForFile } from '../src/leases/units';
import { checkProfile, loadProfile, pinnedCheck, verifyLocalProfile, type LocalProfile } from './profiles';
import { commitGenerated, regenerate, type GeneratedOutput } from './generators';

type UnsignedResult = JobResult extends infer R ? R extends JobResult ? Omit<R, 'resultDigest'> : never : never;
const tailLog = (value: string, cap: number): string => {
  let tail = Buffer.from(value).subarray(Math.max(0, Buffer.byteLength(value) - cap)).toString('utf8');
  while (Buffer.byteLength(tail) > cap) tail = tail.slice(1);
  return tail;
};

function cappedChecks(cap: number, commandProfile: boolean) {
  let body = '';
  const markers: string[] = [];
  let markerBytes = 0;
  return {
    append(log: string, label = '') {
      const exit = commandProfile ? /^exit=-?\d+(?: timeout)?\n/.exec(log)?.[0] : undefined;
      if (commandProfile && !exit) throw new Error('COMMAND_EXIT_MARKER_MISSING');
      if (exit) {
        const marker = tailLog(label, cap - Buffer.byteLength(exit)) + exit;
        markerBytes += Buffer.byteLength(marker);
        if (markerBytes > cap) throw new Error('EXIT_MARKERS_EXCEED_OUTPUT_CAP');
        markers.push(marker);
      }
      body = tailLog(body + label + (exit ? log.slice(exit.length) : log) + '\n', cap - markerBytes);
    },
    value() {
      return body + markers.join('');
    },
  };
}

export type Credential = { storageName: string; remote: string; secret: string; expiresAt: number };
export type CredentialProvider = (operation: 'fetch' | 'scratch-push' | 'canonical-push') => Promise<Credential[]>;
const oidPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const checkOid = (oid: string) => { if (!oidPattern.test(oid)) throw new Error('INVALID_OID'); };
const remote = (job: Job, name: string) => {
  const value = job.storageRemotes[name];
  if (!value) throw new Error('REMOTE_NOT_ASSIGNED');
  const parsed = new URL(value);
  if (!['https:', 'file:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('UNSAFE_REMOTE');
  return value;
};

async function fetchInput(directory: string, job: Job, name: string, oid: string, credentials: Credential[]): Promise<void> {
  const item = credentials.find(value => value.storageName === name);
  if (!item || item.remote !== remote(job, name)) throw new Error('FETCH_CREDENTIAL_MISMATCH');
  await fetchOid(directory, item.remote, oid, await gitCredentialEnvironment(directory, item.secret));
}

async function compose(directory: string, base: string, inputs: CandidateInput[], job: Job, profile: LocalProfile): Promise<string> {
  await git(directory, ['switch', '--detach', base]);
  const env = childEnvironment({ GIT_AUTHOR_NAME: 'Concord Runner', GIT_AUTHOR_EMAIL: 'runner@concord.invalid',
    GIT_COMMITTER_NAME: 'Concord Runner', GIT_COMMITTER_EMAIL: 'runner@concord.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' });
  for (const candidate of inputs) {
    if (!await isAncestor(directory, candidate.baseOid, candidate.headOid) ||
      !await isAncestor(directory, candidate.baseOid, await git(directory, ['rev-parse', 'HEAD']))) throw new Error('CANDIDATE_ANCESTRY');
    const result = await command('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      'merge', '--no-edit', '--no-ff', candidate.headOid], directory, 60_000, env);
    if (result.code === 0) continue;
    const conflicts = (await git(directory, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
    if (!conflicts.length) throw new Error('MERGE_CONFLICT');
    for (const path of conflicts) {
      if (generatorForFile(job.unitPolicy, path)) {
        const present = await git(directory, ['ls-tree', 'HEAD', '--', path]);
        if (present) await git(directory, ['restore', '--source=HEAD', '--staged', '--worktree', '--', path]);
        else await git(directory, ['rm', '-f', '--', path]);
        continue;
      }
      const table = tableForFile(job.unitPolicy, path);
      if (!table) throw new Error('MERGE_CONFLICT');
      const stages = await git(directory, ['ls-files', '--stage', '--', path]);
      const modes = stages.split('\n').filter(Boolean).map(line => line.split(' ')[0]);
      if (modes.length !== 3 || new Set(modes).size !== 1) throw new Error('MERGE_CONFLICT');
      const readStage = async (stage: number) => {
        const value = await command('git', ['show', ':' + stage + ':' + path], directory, 30_000);
        if (value.code !== 0 || value.truncated) throw new Error('MERGE_CONFLICT');
        return value.stdout;
      };
      const merged = mergeTsv(await readStage(1), await readStage(2), await readStage(3), table);
      await writeFile(directory + '/' + path, merged);
      await git(directory, ['add', '--', path]);
    }
    await git(directory, ['commit', '--no-edit'], 60_000, env);
  }
  if (inputs.length) {
    await regenerate(directory, job.unitPolicy, profile, job.maxOutputBytes);
    return commitGenerated(directory, job.unitPolicy);
  }
  return git(directory, ['rev-parse', 'HEAD']);
}

/** Delta review records the candidate's derived digest while checking the new combined tree. */
async function candidateGenerated(directory: string, job: Job, profile: LocalProfile, head: string): Promise<GeneratedOutput[]> {
  if (!declaredGenerators(job.unitPolicy).length) return [];
  await git(directory, ['switch', '--detach', head]);
  const generated = await regenerate(directory, job.unitPolicy, profile, job.maxOutputBytes);
  for (const path of declaredGenerators(job.unitPolicy).flatMap(entry => entry.outputs)) {
    const tracked = await command('git', ['ls-files', '--error-unmatch', '--', path], directory, 30_000);
    if (tracked.code === 0) await git(directory, ['restore', '--source=HEAD', '--staged', '--worktree', '--', path]);
    else await rm(resolve(directory, path), { force: true });
  }
  return generated;
}

async function runGates(profile: LocalProfile, job: Job, directory: string): Promise<{ outcome: CheckOutcome; gates: StackResult['gateResults']; log: string; score: StackResult['score'] }> {
  // 128 markers fit the 4096-byte command minimum even with 32 bytes reserved per exit line.
  if (profile.kind === 'command' && job.unitPolicy.acceptance.gates.length > 128)
    throw new Error('TOO_MANY_COMMAND_GATES');
  const gates: StackResult['gateResults'] = [];
  const log = cappedChecks(Math.min(job.maxOutputBytes, OUTPUT_CAP), profile.kind === 'command');
  let score: StackResult['score'] = null;
  for (const gate of job.unitPolicy.acceptance.gates) {
    const checked = await pinnedCheck(profile, job, directory, gate.id);
    gates.push({ gateId: gate.id, outcome: checked.outcome });
    log.append(checked.log);
    score = job.contest === true ? checked.score : null;
    if (checked.outcome !== gate.requiredOutcome) return { outcome: checked.outcome === 'TIMEOUT' || checked.outcome === 'ENV_ERROR' ? checked.outcome : 'FAIL', gates, log: log.value(), score: null };
  }
  return { outcome: 'PASS', gates, log: log.value(), score };
}

async function runAffected(profile: LocalProfile, job: Job, directory: string, unitKeys: string[]): Promise<{ outcome: CheckOutcome; log: string }> {
  const targets = profile.checkerId === 'dispatch-lab' ? ['all'] : [...new Set(unitKeys)].sort(compareKeys);
  if (!targets.length) return { outcome: 'UNVERIFIED_TARGET', log: 'No affected units identified' };
  const log = cappedChecks(Math.min(job.maxOutputBytes, OUTPUT_CAP), profile.kind === 'command');
  for (const unit of targets) {
    const checked = await pinnedCheck(profile, job, directory, unit);
    log.append(checked.log, unit + ': ');
    if (!['PASS', 'MATCH'].includes(checked.outcome)) return { outcome: checked.outcome, log: log.value() };
  }
  return { outcome: 'PASS', log: log.value() };
}

async function reconcileScratch(directory: string, job: Extract<Job, { kind: 'validate-stack' }>, composed: string,
  provide: CredentialProvider): Promise<string> {
  const tokens = await provide('fetch');
  const item = tokens.find(value => value.storageName === job.scratchStorageName);
  if (!item || item.remote !== remote(job, job.scratchStorageName)) throw new Error('SCRATCH_CREDENTIAL_MISMATCH');
  const ref = job.scratchRef.startsWith('refs/') ? job.scratchRef : 'refs/heads/' + job.scratchRef;
  const observed = await refOid(directory, item.remote, ref, await gitCredentialEnvironment(directory, item.secret));
  if (!observed || observed === job.expectedRefs[job.scratchStorageName] || observed === composed) return composed;
  if (!job.bootstrap && job.baseCheck) throw new Error('SCRATCH_OLD_REF');
  await fetchInput(directory, job, job.scratchStorageName, observed, tokens);
  if (await treeOid(directory, observed) !== await treeOid(directory, composed) ||
    (job.bootstrap ? observed !== job.candidates[0].headOid :
      !await isAncestor(directory, job.canonicalBaseOid, observed) ||
      (await Promise.all(job.candidates.map(candidate => isAncestor(directory, candidate.headOid, observed)))).some(found => !found)))
    throw new Error('SCRATCH_OLD_REF');
  await git(directory, ['switch', '--detach', observed]);
  return observed;
}

async function executeIn(directory: string, job: Job, profile: LocalProfile | null, provide: CredentialProvider): Promise<UnsignedResult> {
  await initWorktree(directory);
  const fetchTokens = await provide('fetch');
  const common = { jobId: job.jobId, attempt: job.attempt, inputDigest: job.inputDigest, fence: job.fence,
    checkerDigest: job.checkerDigest, toolchainDigest: job.toolchainDigest, oracleDigest: job.oracleDigest,
    environmentDigest: job.environmentDigest, durationMs: 0, log: '', sourceTreeOid: null };
  if (job.kind === 'inspect-candidate') {
    const candidate = job.candidate;
    const name = 'seedStorageName' in candidate ? candidate.seedStorageName : candidate.storageName;
    await fetchInput(directory, job, name, candidate.headOid, fetchTokens);
    if (candidate.baseOid) await fetchInput(directory, job, name, candidate.baseOid, fetchTokens);
    const actual = await git(directory, ['rev-parse', candidate.headOid + '^{commit}']);
    if (candidate.baseOid && !await isAncestor(directory, candidate.baseOid, actual)) throw new Error('CANDIDATE_ANCESTRY');
    await git(directory, ['switch', '--detach', actual]);
    const generated = await regenerate(directory, job.unitPolicy, profile!, job.maxOutputBytes);
    const inspected = await inspectUnits(directory, candidate.baseOid, actual, job, undefined, generated);
    // A command profile validates the inspected tree as well as composed stacks.
    // Dispatch-lab inspection retains its existing manifest-only behavior.
    let outcome: CheckOutcome = 'PASS';
    let log = '';
    if (profile?.kind === 'command') {
      await git(directory, ['switch', '--detach', actual]);
      const checked = await pinnedCheck(profile, job, directory);
      outcome = checked.outcome;
      log = checked.log;
    }
    return { ...common, kind: 'inspect-candidate', outcome, log, observedHeadOid: actual,
      sourceTreeOid: await treeOid(directory, actual), unitKeys: inspected.unitKeys,
      reviewManifest: inspected.manifest, reviewManifestDigest: inspected.digest };
  }
  if (job.kind === 'validate-stack') {
    if (!profile) throw new Error('PROFILE_REQUIRED');
    let composed: string;
    if (job.bootstrap) {
      if (!job.ownerAuthorized || job.candidates.length !== 1 || job.canonicalBaseOid !== null) throw new Error('BOOTSTRAP_UNAUTHORIZED');
      const seed = job.candidates[0];
      await fetchInput(directory, job, seed.seedStorageName, seed.headOid, fetchTokens);
      composed = seed.headOid;
      await git(directory, ['switch', '--detach', composed]);
      await regenerate(directory, job.unitPolicy, profile, job.maxOutputBytes);
      composed = await commitGenerated(directory, job.unitPolicy);
    } else {
      checkOid(job.canonicalBaseOid);
      const candidates = new Set(job.candidates.map(candidate => candidate.storageName));
      const baseName = Object.entries(job.expectedRefs).find(([name, value]) => name !== job.scratchStorageName &&
        !candidates.has(name) && value === job.canonicalBaseOid)?.[0];
      if (!baseName) throw new Error('CANONICAL_BASE_UNPINNED');
      await fetchInput(directory, job, baseName, job.canonicalBaseOid, fetchTokens);
      for (const candidate of job.candidates) {
        await fetchInput(directory, job, candidate.storageName, candidate.baseOid, fetchTokens);
        await fetchInput(directory, job, candidate.storageName, candidate.headOid, fetchTokens);
      }
      composed = await compose(directory, job.canonicalBaseOid, job.candidates, job, profile);
      if (job.baseCheck && composed !== job.canonicalBaseOid) throw new Error('BASE_CHECK_IDENTITY');
    }
    composed = await reconcileScratch(directory, job, composed, provide);
    const tree = await treeOid(directory, composed);
    const checked = await runGates(profile, job, directory);
    if (checked.outcome === 'PASS') {
      const pushTokens = await provide('scratch-push');
      const item = pushTokens.find(value => value.storageName === job.scratchStorageName);
      if (!item || item.remote !== remote(job, job.scratchStorageName)) throw new Error('SCRATCH_CREDENTIAL_MISMATCH');
      const expected = job.expectedRefs[job.scratchStorageName] ?? null;
      const pushed = await conditionalPush(directory, item.remote, composed, expected,
        await gitCredentialEnvironment(directory, item.secret), job.scratchRef.startsWith('refs/') ? job.scratchRef : 'refs/heads/' + job.scratchRef);
      if (pushed !== 'APPLIED') throw new Error('SCRATCH_OLD_REF');
    }
    return { ...common, kind: 'validate-stack', bootstrap: job.bootstrap, canonicalBaseOid: job.canonicalBaseOid,
      sourceTreeOid: tree, composedOid: composed, composedTreeOid: tree,
      outcome: checked.outcome, gateResults: checked.gates, score: checked.score, log: checked.log } as UnsignedResult;
  }
  if (job.kind === 'delta-check') {
    if (!profile) throw new Error('PROFILE_REQUIRED');
    const baseName = Object.entries(job.expectedRefs).find(([name, value]) => name !== job.candidate.storageName && value === job.newBaseOid)?.[0];
    if (!baseName) throw new Error('NEW_BASE_UNPINNED');
    await fetchInput(directory, job, baseName, job.newBaseOid, fetchTokens);
    await fetchInput(directory, job, job.candidate.storageName, job.candidate.baseOid, fetchTokens);
    await fetchInput(directory, job, job.candidate.storageName, job.candidate.headOid, fetchTokens);
    const generated = await candidateGenerated(directory, job, profile, job.candidate.headOid);
    const composed = await compose(directory, job.newBaseOid, [job.candidate], job, profile);
    const inspected = await inspectUnits(directory, job.newBaseOid, composed, job, undefined, generated);
    const checked = inspected.manifest.coverage === 'complete' ? await runAffected(profile, job, directory, inspected.unitKeys) :
      { outcome: 'UNVERIFIED_TARGET' as CheckOutcome, log: 'Unknown review dependency scope' };
    return { ...common, kind: 'delta-check', outcome: checked.outcome, sourceTreeOid: await treeOid(directory, composed),
      reviewManifest: inspected.manifest, reviewManifestDigest: inspected.digest,
      dependencyScope: inspected.manifest.dependencyScope, dependencyScopeDigest: await digest(inspected.manifest.dependencyScope),
      log: checked.log };
  }
  // Promoter mode has no profile load, checkout, source execution, or checker invocation.
  if (job.bootstrap && (!job.ownerAuthorized || job.expectedOldOid !== null)) throw new Error('BOOTSTRAP_UNAUTHORIZED');
  await fetchInput(directory, job, job.scratchStorageName, job.checkedNewOid, fetchTokens);
  const scratchCredential = fetchTokens.find(value => value.storageName === job.scratchStorageName);
  if (!scratchCredential || await refOid(directory, scratchCredential.remote, job.scratchRef.startsWith('refs/') ? job.scratchRef : 'refs/heads/' + job.scratchRef,
    await gitCredentialEnvironment(directory, scratchCredential.secret)) !== job.checkedNewOid) throw new Error('PROMOTION_TICKET_MISMATCH');
  const canonicalName = Object.keys(job.expectedRefs).find(name => name !== job.scratchStorageName);
  if (!canonicalName) throw new Error('CANONICAL_REMOTE_MISSING');
  if (job.expectedOldOid) {
    await fetchInput(directory, job, canonicalName, job.expectedOldOid, fetchTokens);
    if (!await isAncestor(directory, job.expectedOldOid, job.checkedNewOid)) throw new Error('PROMOTION_ANCESTRY');
  }
  const pushTokens = await provide('canonical-push');
  const item = pushTokens.find(value => value.storageName === canonicalName);
  if (!item || item.remote !== remote(job, canonicalName)) throw new Error('CANONICAL_CREDENTIAL_MISMATCH');
  const env = await gitCredentialEnvironment(directory, item.secret);
  const outcome = await conditionalPush(directory, item.remote, job.checkedNewOid, job.expectedOldOid, env);
  const observedCanonicalOid = await refOid(directory, item.remote, 'refs/heads/main', env);
  return { ...common, kind: 'promote', outcome, observedCanonicalOid, sourceTreeOid: await treeOid(directory, job.checkedNewOid) };
}

export async function executeJob(job: Job, profile: LocalProfile | null, provide: CredentialProvider): Promise<JobResult> {
  const began = Date.now();
  const secrets = new Set<string>();
  const tracked: CredentialProvider = async operation => {
    const credentials = await provide(operation);
    for (const credential of credentials) if (credential.secret) secrets.add(credential.secret);
    return credentials;
  };
  let value: UnsignedResult;
  try {
    if (job.kind === 'promote' && profile) throw new Error('PROMOTER_PROFILE_FORBIDDEN');
    if (job.kind !== 'promote') {
      if (!profile) throw new Error('PROFILE_REQUIRED');
      if (profile.sourcePath) profile = await loadProfile(profile.sourcePath);
      checkProfile(job, profile);
      if (profile.sourcePath) await verifyLocalProfile(profile);
    }
    value = await withJobDeadline(began + job.timeoutMs, () => temporaryWork(directory => executeIn(directory, job, profile, tracked)));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown runner failure';
    const outcome = message.includes('GENERATOR_NONDETERMINISTIC') ? 'GENERATOR_NONDETERMINISTIC' :
      message.includes('GENERATOR_FAILED') ? 'GENERATOR_FAILED' :
      message.includes('MERGE_CONFLICT') || message.includes('TSV_COLLISION') || message.includes('INVALID_TSV') ? 'MERGE_CONFLICT' :
      message.includes('TIMEOUT') ? 'TIMEOUT' : 'ENV_ERROR';
    const common = { jobId: job.jobId, attempt: job.attempt, inputDigest: job.inputDigest, fence: job.fence,
      checkerDigest: job.checkerDigest, toolchainDigest: job.toolchainDigest, oracleDigest: job.oracleDigest,
      environmentDigest: job.environmentDigest, durationMs: 0, log: message.slice(0, OUTPUT_CAP), sourceTreeOid: null };
    value = job.kind === 'inspect-candidate' ? { ...common, kind: job.kind, outcome, observedHeadOid: null,
      unitKeys: [], reviewManifestDigest: null, reviewManifest: null } :
      job.kind === 'validate-stack' ? { ...common, kind: job.kind, outcome, bootstrap: job.bootstrap,
        canonicalBaseOid: job.canonicalBaseOid, composedOid: null, composedTreeOid: null, gateResults: [], score: null } as UnsignedResult :
        job.kind === 'delta-check' ? { ...common, kind: job.kind, outcome, reviewManifestDigest: null, reviewManifest: null,
          dependencyScopeDigest: null, dependencyScope: null } :
          { ...common, kind: 'promote', outcome: 'ENV_ERROR', observedCanonicalOid: null };
  }
  value.durationMs = Math.max(0, Date.now() - began);
  for (const secret of secrets) value.log = value.log.replaceAll(secret, '[REDACTED]');
  const cap = Math.min(job.maxOutputBytes, OUTPUT_CAP);
  if (value.kind === 'validate-stack' || value.kind === 'delta-check') value.log = tailLog(value.log, cap);
  else while (Buffer.byteLength(value.log) > cap) value.log = value.log.slice(0, -1);
  const resultDigest = await digest(value);
  return { ...value, resultDigest } as JobResult;
}
