#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ConcordClient, ConcordError, idempotencyKey, redactOutput, rememberCredential, rememberCredentialsIn, type RequestOptions } from './client.ts';
import { assertCommit, assertHeadBasedOn, cloneRepo, fetchFork, pushCandidate, rejectCanonicalTarget, resolveHead } from './git.ts';
import { importRepo } from './import.ts';
import { land } from './land.ts';
import { mintGitToken } from './git-token.ts';
import { releaseByIntent, renewByIntent, start } from './start.ts';

const HELP = `Concord agent CLI

Usage: npm run concord -- <noun> <verb> [options]

Connection: CONCORD_URL and CONCORD_TOKEN; alternatively --token-stdin reads one token from stdin.
Common: --repo ID --json --idempotency-key KEY --expected-version N
Mutations generate an idempotency key when omitted. Responses are JSON on stdout; errors are JSON on stderr.

Commands and required fields:
  start --repo ID --intent-key KEY --intent TEXT --allowed-files FILE [--base OID] [--hold 2h] [--json]
  release --repo ID --intent-key KEY
  renew --repo ID --intent-key KEY [--hold 5m] [--every SECONDS [--while-pid PID]] [--json]
  land --repo ID --source PATH --commit SHA [--base 40_HEX_OID] --intent-key KEY --intent TEXT --allowed-files FILE [--depends-on CHANGE_ID ...] [--review-evidence FILE] [--mirror-to HTTPS_GIT_URL]
  land --repo ID --aw-run RUN_DIR --base 40_HEX_OID [--review-evidence FILE] [--mirror-to HTTPS_GIT_URL]
  repo create --name NAME --policy-id ID --profile-id ID
  repo list [--cursor CURSOR]
  principals mint --role agent|reviewer|viewer|checker [--repo ID] [--ttl 30d] [--name NAME]
  principals list [--cursor CURSOR]
  principals revoke ID
  repo clone --repo ID --path PATH                 (read-only canonical clone)
  import --source PATH --ref REF --repo NAME --policy-id ID --profile-id ID [--with-history] [--exclude GLOB ...] [--exclude-file FILE] [--require-match] [--print-tree]
  change create --repo ID --intent-key KEY --intent-text TEXT --base-oid OID|null --branch NAME --unit-keys JSON_ARRAY [--dependency-change-ids JSON_ARRAY]
  issue create|list|get|edit|close|reopen --repo ID [--id NUMBER] [--title TEXT] [--body TEXT] [--labels JSON_ARRAY] [--milestone-id ID] [--reason TEXT]
  milestone create|list|get|close --repo ID [--id ID] [--title TEXT] [--description TEXT] [--due-date YYYY-MM-DD]
  change get --repo ID --id ID
  change checkout --repo ID --id ID --worktree PATH
  change publish --repo ID --id ID --worktree PATH --lease-fences JSON_OBJECT
  change close --repo ID --id ID --expected-version N [--reason TEXT]
  lease claim --repo ID --change-id ID --unit-keys JSON_ARRAY --intent-text TEXT --expected-version N [--ttl-seconds N]
  lease list --repo ID
  lease renew --repo ID --id ID --fence N --expected-version N [--ttl-seconds N]
  lease release --repo ID --id ID [--fence N | --force --reason TEXT] --expected-version N
  queue list --repo ID
  queue enqueue --repo ID --change-id ID --verdict-id ID --lease-fences JSON_OBJECT --expected-version N
  queue withdraw --repo ID --change-id ID --reason TEXT --expected-version N
  finding list --repo ID --change-id ID
  finding add --repo ID --change-id ID --revision N --unit-key KEY --text TEXT --evidence-digest sha256:... --expected-version N
  repair submit --repo ID --change-id ID --revision N --finding-set-version N --dispositions JSON_ARRAY --expected-version N
  repair review --repo ID --change-id ID --round-id ID --revision N --finding-set-version N --decision accept|reject --evidence-digest sha256:... --expected-version N
  verdict add --repo ID --change-id ID --revision N --review-manifest-digest sha256:... --finding-set-version N --decision approve|reject --evidence-digest sha256:... --expected-version N
  verdict carry --repo ID --change-id ID --parent-verdict-id ID --revision N --new-base-oid OID --expected-version N
  events list --repo ID [--after SEQUENCE]
  events --tenant [--cursor CURSOR]
  metrics --repo ID --since ISO_UTC --until ISO_UTC
  api METHOD PATH [--body-file PATH]                 (advanced API; mutations need --idempotency-key)

Generic JSON bodies may also be supplied through --body-file. HTTP 501 MODULE_UNAVAILABLE responses remain explicit server errors.
`;

type Flags = Record<string, string | boolean | undefined>;
const OPTION_NAMES = ['repo', 'idempotency-key', 'expected-version', 'body-file', 'name', 'policy-id', 'profile-id', 'path', 'id', 'intent-key', 'intent-text', 'base-oid', 'branch', 'unit-keys', 'dependency-change-ids', 'lease-fences', 'reason', 'change-id', 'ttl-seconds', 'fence', 'verdict-id', 'revision', 'unit-key', 'text', 'evidence-digest', 'finding-set-version', 'dispositions', 'round-id', 'decision', 'review-manifest-digest', 'parent-verdict-id', 'new-base-oid', 'after', 'worktree', 'cursor', 'source', 'ref', 'exclude-file', 'commit', 'base', 'intent', 'allowed-files', 'review-evidence', 'mirror-to', 'wait-seconds', 'aw-run', 'issue', 'title', 'body', 'labels', 'milestone-id', 'due-date', 'description', 'state', 'label', 'limit', 'every', 'while-pid'];

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  let parsed;
  try {
    const options: Record<string, { type: 'string'; multiple?: boolean } | { type: 'boolean' }> = {};
    for (const name of [...OPTION_NAMES, 'role', 'ttl', 'hold', 'since', 'until']) options[name] = { type: 'string' };
    options.exclude = { type: 'string', multiple: true };
    options['depends-on'] = { type: 'string', multiple: true };
    options.json = { type: 'boolean' };
    options.help = { type: 'boolean' };
    options['print-tree'] = { type: 'boolean' };
    options['require-match'] = { type: 'boolean' };
    options['with-history'] = { type: 'boolean' };
    options.force = { type: 'boolean' };
    options.verbose = { type: 'boolean' };
    options.tenant = { type: 'boolean' };
    options['token-stdin'] = { type: 'boolean' };
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) { throw new ConcordError(`${error instanceof Error ? error.message : error}\n\n${HELP}`, 'usage'); }
  const [noun, verb, ...args] = parsed.positionals;
  const flags = parsed.values as Flags;
  if (!noun || noun === 'help' || flags.help) { print({ help: HELP }); return; }
  if (noun === 'start' && !verb && !args.length) return print(await start({
    repo: required(flags, 'repo'), intentKey: required(flags, 'intent-key'), intent: required(flags, 'intent'),
    allowedFiles: required(flags, 'allowed-files'), base: typeof flags.base === 'string' ? flags.base : undefined,
    hold: typeof flags.hold === 'string' ? flags.hold : undefined,
    client: await clientFor(flags),
  }));
  if (noun === 'release' && !verb && !args.length) return print(await releaseByIntent(required(flags, 'repo'), required(flags, 'intent-key'), await clientFor(flags)));
  if (noun === 'renew' && !verb && !args.length) return print(await renewByIntent({
    repo: required(flags, 'repo'), intentKey: required(flags, 'intent-key'),
    hold: typeof flags.hold === 'string' ? flags.hold : undefined,
    every: flags.every === undefined ? undefined : numberFlag(flags, 'every'),
    whilePid: flags['while-pid'] === undefined ? undefined : numberFlag(flags, 'while-pid'),
    client: await clientFor(flags),
  }));
  if (noun === 'land' && !verb && !args.length) {
    const values = parsed.values;
    await land({ repo: typeof flags.repo === 'string' ? flags.repo : undefined,
      source: typeof flags.source === 'string' ? flags.source : undefined,
      commit: typeof flags.commit === 'string' ? flags.commit : undefined,
      base: typeof flags.base === 'string' ? flags.base : undefined,
      intentKey: typeof flags['intent-key'] === 'string' ? flags['intent-key'] : undefined,
      intent: typeof flags.intent === 'string' ? flags.intent : undefined,
      allowedFiles: typeof flags['allowed-files'] === 'string' ? flags['allowed-files'] : undefined,
      dependsOn: Array.isArray(values['depends-on']) ? values['depends-on'] : undefined,
      reviewEvidence: typeof flags['review-evidence'] === 'string' ? flags['review-evidence'] : undefined,
      mirrorTo: typeof flags['mirror-to'] === 'string' ? flags['mirror-to'] : undefined,
      waitSeconds: flags['wait-seconds'] === undefined ? undefined : numberFlag(flags, 'wait-seconds'),
      expectedVersion: flags['expected-version'] === undefined ? undefined : numberFlag(flags, 'expected-version'),
      awRun: typeof flags['aw-run'] === 'string' ? flags['aw-run'] : undefined, json: values.json === true });
    return;
  }
  if (noun === 'import' && !verb && !args.length) {
    const values = parsed.values;
    const printTree = values['print-tree'] === true;
    const result = await importRepo({ source: required(flags, 'source'), ref: required(flags, 'ref'),
      repo: required(flags, 'repo'), policyId: typeof flags['policy-id'] === 'string' ? flags['policy-id'] : undefined,
      profileId: typeof flags['profile-id'] === 'string' ? flags['profile-id'] : undefined,
      excludes: Array.isArray(values.exclude) ? values.exclude : [], excludeFile: typeof flags['exclude-file'] === 'string' ? flags['exclude-file'] : undefined,
      requireMatch: values['require-match'] === true,
      expectedVersion: flags['expected-version'] === undefined ? undefined : numberFlag(flags, 'expected-version'),
      printTree, verbose: values.verbose === true, withHistory: values['with-history'] === true }, printTree ? undefined : await clientFor(flags));
    return print(result);
  }
  if (noun === 'api') {
    const method = verb;
    const path = args[0];
    if (!method || !path) throw new ConcordError('api requires METHOD PATH', 'usage');
    const client = await clientFor(flags);
    const body = flags['body-file'] ? await bodyFile(String(flags['body-file'])) : undefined;
    return print(await client.request(method, path, requestOptions(flags, body)));
  }
  const client = await clientFor(flags);
  const repo = String(flags.repo ?? '');
  const requireRepo = () => { if (!repo) throw new ConcordError(`${noun} ${verb ?? ''} requires --repo`, 'usage'); return encodeURIComponent(repo); };
  const body = flags['body-file'] ? await bodyFile(String(flags['body-file'])) : undefined;
  const send = (method: string, path: string, payload?: unknown) => client.request(method, path, requestOptions(flags, payload));
  const mutateExisting = (path: string, payload: unknown) => {
    const options = requestOptions(flags, payload);
    if (options.expectedVersion === undefined) throw new ConcordError('--expected-version is required when mutating an existing resource', 'usage');
    return client.request('POST', path, options);
  };

  if (noun === 'principals') {
    if (verb === 'list') return print(await client.request('GET', `/principals${query({ cursor: flags.cursor })}`));
    if (verb === 'revoke') {
      if (args.length !== 1 || !/^[A-Za-z0-9_-]{1,64}$/.test(args[0])) throw new ConcordError('principals revoke requires an ID', 'usage');
      return print(await client.request('DELETE', `/principals/${args[0]}`));
    }
    if (verb === 'mint') {
      const role = required(flags, 'role');
      if (!['agent', 'reviewer', 'viewer', 'checker'].includes(role)) throw new ConcordError('--role must be agent, reviewer, viewer, or checker', 'usage');
      const payload: Record<string, unknown> = { roles: [role] };
      if (repo) payload.repoIds = [repo];
      if (flags.name !== undefined) payload.name = flags.name;
      if (flags.ttl !== undefined) {
        const match = /^([1-9][0-9]*)([smhd])$/.exec(String(flags.ttl));
        if (!match) throw new ConcordError('--ttl must use positive seconds, minutes, hours, or days (for example 30d)', 'usage');
        const seconds = Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 } as const)[match[2] as 's' | 'm' | 'h' | 'd'];
        if (!Number.isSafeInteger(seconds)) throw new ConcordError('--ttl is too large', 'usage');
        payload.ttlSeconds = seconds;
      }
      const result = unwrap(await client.request('POST', '/principals', requestOptions(flags, payload)));
      if (!result || typeof result !== 'object' || typeof (result as { token?: unknown }).token !== 'string' || !/^cct_[A-Za-z0-9_-]+_[a-f0-9]{64}$/.test((result as { token: string }).token)) {
        throw new ConcordError('Mint response did not include a valid token', 'server');
      }
      const minted = result as { token: string; id?: unknown; expiresAt?: unknown };
      rememberCredential(minted.token);
      process.stdout.write(`${minted.token}\n`);
      if (role === 'checker') {
        const expiry = typeof minted.expiresAt === 'number' && Math.abs(minted.expiresAt) <= 8.64e15
          ? `, expires ${new Date(minted.expiresAt).toISOString()}` : '';
        process.stderr.write(
          `Minted checker principal ${typeof minted.id === 'string' ? minted.id : '(id unknown)'}${expiry}; the token above is shown once.\n` +
          'On the runner machine, load it without writing it to shell history:\n' +
          '  read -rs CHECKER_TOKEN && export CHECKER_TOKEN    # paste the token at the prompt\n' +
          `  CONCORD_URL=${process.env.CONCORD_URL} CONCORD_TOKEN="$CHECKER_TOKEN" npm run runner -- --repo ${repo || 'REPO_ID'} --role checker --profile "$PROFILE_FILE" --max-jobs 1000 --idle-timeout-seconds 86400\n` +
          `Revoke it with: npm run concord -- principals revoke ${typeof minted.id === 'string' ? minted.id : 'PRINCIPAL_ID'}\n`);
      }
      return;
    }
  }

  if (noun === 'repo' && verb === 'list') return print(await send('GET', `/repos${query({ cursor: flags.cursor })}`));
  if (noun === 'repo' && verb === 'create') {
    const payload = body ?? requiredObject(flags, ['name', 'policy-id', 'profile-id'], { name: 'name', policyId: 'policy-id', profileId: 'profile-id' });
    return print(await send('POST', '/repos', payload));
  }
  if (noun === 'repo' && verb === 'clone') {
    const id = requireRepo();
    const destination = required(flags, 'path');
    const repoResult = unwrap(await send('GET', `/repos/${id}`)) as Record<string, unknown>;
    const storageName = stringField(repoResult, 'canonicalStorageName');
    const tokenResult = unwrap(await mintGitToken(client, { repoPath: `/repos/${id}`, storageName, scope: 'read',
      ...(flags['expected-version'] !== undefined ? { expectedVersion: numberFlag(flags, 'expected-version') } : {}) })) as Record<string, unknown>;
    const remote = stringField(tokenResult, 'remote', true);
    const token = tokenField(tokenResult);
    await cloneRepo(remote, destination, token);
    return print({ cloned: true, repoId: repo, path: destination, access: 'read-only' });
  }

  if (noun === 'events' && flags.tenant && (!verb || verb === 'list')) {
    if (repo || flags.after !== undefined) throw new ConcordError('Tenant events use --cursor without --repo or --after', 'usage');
    return print(await send('GET', `/events${query({ cursor: flags.cursor })}`));
  }
  const rid = requireRepo();
  const root = `/repos/${rid}`;
  if (noun === 'metrics' && !verb) return print(await send('GET', `${root}/metrics${query({ since: required(flags, 'since'), until: required(flags, 'until') })}`));
  if (noun === 'issue') {
    const path = `${root}/issues`;
    if (verb === 'list') return print(await send('GET', `${path}${query({ state: flags.state, label: flags.label, milestoneId: flags['milestone-id'], cursor: flags.cursor, limit: flags.limit })}`));
    if (verb === 'create') return print(await send('POST', path, body ?? { title: required(flags, 'title'), body: flags.body ?? '', labels: flags.labels ? parseJson(String(flags.labels)) : [], ...(flags['milestone-id'] ? { milestoneId: flags['milestone-id'] } : {}), ...(flags['allowed-files'] ? { allowedFiles: parseJson(String(flags['allowed-files'])) } : {}) }));
    const number = Number(required(flags, 'id'));
    if (!Number.isSafeInteger(number) || number < 1) throw new ConcordError('--id must be a positive issue number', 'usage');
    if (verb === 'get') return print(await send('GET', `${path}/${number}`));
    if (verb === 'edit') {
      const payload = body ?? { ...(flags.title !== undefined ? { title: flags.title } : {}), ...(flags.body !== undefined ? { body: flags.body } : {}), ...(flags.labels !== undefined ? { labels: parseJson(String(flags.labels)) } : {}), ...(flags['milestone-id'] !== undefined ? { milestoneId: flags['milestone-id'] } : {}), ...(flags['allowed-files'] !== undefined ? { allowedFiles: parseJson(String(flags['allowed-files'])) } : {}) };
      if (flags['expected-version'] === undefined) throw new ConcordError('--expected-version is required', 'usage');
      return print(await send('PATCH', `${path}/${number}`, payload));
    }
    if (verb === 'close' || verb === 'reopen') return print(await mutateExisting(`${path}/${number}/${verb}`, body ?? { reason: required(flags, 'reason') }));
  }
  if (noun === 'milestone') {
    const path = `${root}/milestones`;
    if (verb === 'list') return print(await send('GET', `${path}${query({ cursor: flags.cursor, limit: flags.limit })}`));
    if (verb === 'create') return print(await send('POST', path, body ?? { title: required(flags, 'title'), description: flags.description ?? '', ...(flags['due-date'] ? { dueDate: flags['due-date'] } : {}) }));
    if (verb === 'get') return print(await send('GET', `${path}/${encodeURIComponent(required(flags, 'id'))}`));
    if (verb === 'close') return print(await mutateExisting(`${path}/${encodeURIComponent(required(flags, 'id'))}/close`, body ?? {}));
  }
  if (noun === 'change' && verb === 'create') {
    const payload = body ?? requiredObject(flags, ['intent-key', 'intent-text', 'base-oid', 'branch', 'unit-keys'], {
      intentKey: 'intent-key', intentText: 'intent-text', baseOid: ['base-oid', value => value === 'null' ? null : value], branch: 'branch', unitKeys: ['unit-keys', parseJson], dependencyChangeIds: ['dependency-change-ids', parseJson, []], issueNumber: ['issue', numberValue],
    });
    return print(await send('POST', `${root}/changes`, payload));
  }
  if (noun === 'change' && verb === 'get') return print(await send('GET', `${root}/changes/${encodeURIComponent(required(flags, 'id'))}`));
  if (noun === 'change' && verb === 'close') {
    const id = encodeURIComponent(required(flags, 'id'));
    return print(await mutateExisting(`${root}/changes/${id}/close`, body ?? { reason: flags.reason ?? 'closed by agent' }));
  }
  if (noun === 'change' && verb === 'checkout') {
    const id = encodeURIComponent(required(flags, 'id'));
    const worktree = required(flags, 'worktree');
    const change = unwrap(await send('GET', `${root}/changes/${id}`)) as Record<string, unknown>;
    const repository = unwrap(await send('GET', `/repos/${rid}`)) as Record<string, unknown>;
    const storageName = stringField(change, 'candidateStorageName');
    const branch = stringField(change, 'branch');
    const access = unwrap(await mintGitToken(client, { repoPath: root, storageName, scope: 'read',
      ...(flags['expected-version'] !== undefined ? { expectedVersion: numberFlag(flags, 'expected-version') } : {}) })) as Record<string, unknown>;
    const remote = stringField(access, 'remote', true);
    await fetchFork(worktree, remote, branch, tokenField(access));
    return print({ fetched: true, changeId: change.changeId ?? flags.id, worktree, branch, remote: redactRemote(remote) });
  }
  if (noun === 'change' && verb === 'publish') {
    const id = encodeURIComponent(required(flags, 'id'));
    const worktree = required(flags, 'worktree');
    const change = unwrap(await send('GET', `${root}/changes/${id}`)) as Record<string, unknown>;
    const repository = unwrap(await send('GET', `/repos/${rid}`)) as Record<string, unknown>;
    const storageName = stringField(change, 'candidateStorageName');
    if (storageName === repository.canonicalStorageName) throw new ConcordError('Refusing to push: server assigned canonical storage as the candidate target', 'server');
    const branch = stringField(change, 'branch');
    const baseOid = stringField(change, 'baseOid');
    if (baseOid === 'null') throw new ConcordError('Cannot publish a seed draft through change publish', 'usage');
    const headOid = await resolveHead(worktree);
    await assertCommit(worktree, baseOid);
    await assertHeadBasedOn(worktree, baseOid, headOid);
    if (!Array.isArray(change.unitKeys) || change.unitKeys.some(key => typeof key !== 'string') || new Set(change.unitKeys).size !== change.unitKeys.length) throw new ConcordError('Server change has an invalid unit key set', 'server');
    const unitKeys = change.unitKeys as string[];
    const fences = parseFences(required(flags, 'lease-fences'));
    const payload = validatePublishPayload(body ?? { baseOid, headOid, branch, unitKeys, leaseFences: fences }, { baseOid, headOid, branch, unitKeys, fences });
    const access = unwrap(await mintGitToken(client, { repoPath: root, storageName, scope: 'write',
      ...(flags['expected-version'] !== undefined ? { expectedVersion: numberFlag(flags, 'expected-version') } : {}) })) as Record<string, unknown>;
    const remote = stringField(access, 'remote', true);
    rejectCanonicalTarget(storageName, repository.canonicalStorageName, remote,
      typeof repository.canonicalRemote === 'string' ? repository.canonicalRemote : typeof repository.remote === 'string' ? repository.remote : undefined);
    await pushCandidate(worktree, remote, branch, tokenField(access), headOid);
    return print(await client.request('POST', `${root}/changes/${id}/publish`, requestOptions(flags, payload, numberField(change, 'version'))));
  }

  if (noun === 'lease' && verb === 'list') return print(await send('GET', `${root}/leases`));
  if (noun === 'lease' && verb === 'claim') return print(await mutateExisting(`${root}/leases`, body ?? requiredObject(flags, ['change-id', 'unit-keys', 'intent-text'], {
    changeId: 'change-id', unitKeys: ['unit-keys', parseJson], intentText: 'intent-text', ttlSeconds: ['ttl-seconds', numberValue, 120],
  })));
  if (noun === 'lease' && (verb === 'renew' || verb === 'release')) {
    const id = encodeURIComponent(required(flags, 'id'));
    if (verb === 'release' && flags.force === true) {
      const payload = body ?? { reason: required(flags, 'reason') };
      return print(await mutateExisting(`${root}/leases/${id}/force-release`, payload));
    }
    const payload = body ?? { fence: numberFlag(flags, 'fence'), ...(verb === 'renew' ? { ttlSeconds: numberFlag(flags, 'ttl-seconds', 120) } : {}) };
    return print(await mutateExisting(`${root}/leases/${id}/${verb}`, payload));
  }
  if (noun === 'queue' && verb === 'list') return print(await send('GET', `${root}/queue`));
  if (noun === 'queue' && verb === 'enqueue') return print(await mutateExisting(`${root}/queue/enqueue`, body ?? requiredObject(flags, ['change-id', 'verdict-id', 'lease-fences'], {
    changeId: 'change-id', verdictId: 'verdict-id', leaseFences: ['lease-fences', parseJson],
  })));
  if (noun === 'queue' && verb === 'withdraw') return print(await mutateExisting(`${root}/queue/withdraw`, body ?? requiredObject(flags, ['change-id', 'reason'], { changeId: 'change-id', reason: 'reason' })));

  if (noun === 'finding' && (verb === 'list' || verb === 'add')) {
    const changeId = encodeURIComponent(required(flags, 'change-id'));
    if (verb === 'list') return print(await send('GET', `${root}/changes/${changeId}/findings`));
    return print(await mutateExisting(`${root}/changes/${changeId}/findings`, body ?? requiredObject(flags, ['revision', 'unit-key', 'text', 'evidence-digest'], {
      revision: ['revision', numberValue], unitKey: 'unit-key', text: 'text', evidenceDigest: 'evidence-digest',
    })));
  }
  if (noun === 'repair' && (verb === 'submit' || verb === 'review')) {
    const changeId = encodeURIComponent(required(flags, 'change-id'));
    const path = `${root}/changes/${changeId}/repairs${verb === 'review' ? `/${encodeURIComponent(required(flags, 'round-id'))}/review` : ''}`;
    if (verb === 'submit') return print(await mutateExisting(path, body ?? requiredObject(flags, ['revision', 'finding-set-version', 'dispositions'], {
      revision: ['revision', numberValue], findingSetVersion: ['finding-set-version', numberValue], dispositions: ['dispositions', parseJson],
    })));
    return print(await mutateExisting(path, body ?? requiredObject(flags, ['revision', 'finding-set-version', 'decision', 'evidence-digest'], {
      revision: ['revision', numberValue], findingSetVersion: ['finding-set-version', numberValue], decision: 'decision', evidenceDigest: 'evidence-digest',
    })));
  }
  if (noun === 'verdict' && (verb === 'add' || verb === 'carry')) {
    const changeId = encodeURIComponent(required(flags, 'change-id'));
    const path = `${root}/changes/${changeId}/${verb === 'add' ? 'verdicts' : 'carry'}`;
    if (verb === 'add') return print(await mutateExisting(path, body ?? requiredObject(flags, ['revision', 'review-manifest-digest', 'finding-set-version', 'decision', 'evidence-digest'], {
      revision: ['revision', numberValue], reviewManifestDigest: 'review-manifest-digest', findingSetVersion: ['finding-set-version', numberValue], decision: 'decision', evidenceDigest: 'evidence-digest',
    })));
    return print(await mutateExisting(path, body ?? requiredObject(flags, ['parent-verdict-id', 'revision', 'new-base-oid'], {
      parentVerdictId: 'parent-verdict-id', revision: ['revision', numberValue], newBaseOid: 'new-base-oid',
    })));
  }
  if (noun === 'events' && verb === 'list') return print(await send('GET', `${root}/events${query({ after: flags.after })}`));
  throw new ConcordError(`Unknown command: ${[noun, verb, ...args].filter(Boolean).join(' ')}\n\n${HELP}`, 'usage');
}

async function clientFor(flags: Flags): Promise<ConcordClient> {
  const url = process.env.CONCORD_URL;
  if (!url) throw new ConcordError('CONCORD_URL is required', 'usage');
  let token = process.env.CONCORD_TOKEN;
  if (flags['token-stdin']) {
    if (process.stdin.isTTY) throw new ConcordError('--token-stdin requires piped stdin', 'usage');
    token = (await stdinText()).trim();
    rememberCredential(token);
  }
  if (!token) throw new ConcordError('CONCORD_TOKEN is required (or provide --token-stdin)', 'usage');
  return new ConcordClient({ url, token });
}
function requestOptions(flags: Flags, body?: unknown, impliedVersion?: number): RequestOptions {
  const methodHasBody = body !== undefined;
  return {
    ...(methodHasBody ? { body } : {}),
    ...(methodHasBody ? { idempotencyKey: idempotencyKey(typeof flags['idempotency-key'] === 'string' ? flags['idempotency-key'] : undefined) } : {}),
    ...(flags['expected-version'] !== undefined ? { expectedVersion: numberFlag(flags, 'expected-version') } : impliedVersion !== undefined ? { expectedVersion: impliedVersion } : {}),
  };
}
async function bodyFile(path: string): Promise<unknown> {
  try {
    const body: unknown = JSON.parse(await readFile(path, 'utf8'));
    rememberCredentialsIn(body);
    return body;
  }
  catch (error) { throw new ConcordError(`Cannot read JSON body file: ${error instanceof Error ? error.message : error}`, 'usage'); }
}
function required(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.length === 0) throw new ConcordError(`--${name} is required`, 'usage');
  return value;
}
function numberFlag(flags: Flags, name: string, fallback?: number): number {
  const raw = flags[name];
  if (raw === undefined && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new ConcordError(`--${name} must be a non-negative integer`, 'usage');
  return value;
}
function numberValue(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('expected non-negative integer');
  return parsed;
}
function requiredObject(flags: Flags, names: string[], mapping: Record<string, string | readonly [string, (value: string) => unknown, unknown?]>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [target, descriptor] of Object.entries(mapping)) {
    let source: string;
    let convert: ((value: string) => unknown) | undefined;
    let fallback: unknown;
    if (typeof descriptor === 'string') { source = descriptor; convert = undefined; fallback = undefined; }
    else [source, convert, fallback] = descriptor;
    const raw = flags[source];
    if (raw === undefined && fallback !== undefined) { result[target] = fallback; continue; }
    if (typeof raw !== 'string') {
      if (names.includes(source)) throw new ConcordError(`--${source} is required`, 'usage');
      continue;
    }
    try { result[target] = convert ? convert(raw) : raw; }
    catch { throw new ConcordError(`--${source} has an invalid value`, 'usage'); }
  }
  return result;
}
function parseJson(value: string): unknown { return JSON.parse(value); }
function query(values: Record<string, string | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (typeof value === 'string') params.set(key, value);
  const encoded = params.toString(); return encoded ? `?${encoded}` : '';
}
function unwrap(value: unknown): unknown { return value && typeof value === 'object' && 'data' in value ? (value as { data: unknown }).data : value; }
function stringField(value: Record<string, unknown>, name: string, tokenResponse = false): string {
  const found = value[name];
  if (typeof found !== 'string' || !found) throw new ConcordError(`Server response is missing ${name}`, 'server', undefined, tokenResponse ? undefined : safeResponseDiagnostic(value));
  return found;
}
function numberField(value: Record<string, unknown>, name: string): number | undefined { return typeof value[name] === 'number' ? value[name] as number : undefined; }
function tokenField(value: Record<string, unknown>): string {
  for (const key of ['token', 'secret', 'plaintext']) if (typeof value[key] === 'string') { rememberCredential(value[key] as string); return value[key] as string; }
  throw new ConcordError('Git token response did not include a token', 'server');
}
function safeResponseDiagnostic(value: Record<string, unknown>): Record<string, unknown> {
  const diagnostic: Record<string, unknown> = {};
  if (typeof value.version === 'number' && Number.isSafeInteger(value.version)) diagnostic.version = value.version;
  if (typeof value.eventSeq === 'number' && Number.isSafeInteger(value.eventSeq)) diagnostic.eventSeq = value.eventSeq;
  return diagnostic;
}
function parseFences(value: string): Record<string, number> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new ConcordError('--lease-fences has an invalid value', 'usage'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConcordError('--lease-fences must be a JSON object', 'usage');
  for (const [key, fence] of Object.entries(parsed)) {
    if (!key || !Number.isSafeInteger(fence) || (fence as number) < 0) throw new ConcordError('--lease-fences must map unit keys to non-negative integer fences', 'usage');
  }
  return parsed as Record<string, number>;
}
function validatePublishPayload(value: unknown, expected: { baseOid: string; headOid: string; branch: string; unitKeys: string[]; fences: Record<string, number> }): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConcordError('Publish body must be a JSON object', 'usage');
  const payload = value as Record<string, unknown>;
  const payloadUnitKeys = payload.unitKeys;
  if (payload.baseOid !== expected.baseOid || payload.headOid !== expected.headOid || payload.branch !== expected.branch || !Array.isArray(payloadUnitKeys) || payloadUnitKeys.length !== expected.unitKeys.length || new Set(payloadUnitKeys).size !== expected.unitKeys.length || expected.unitKeys.some(key => !payloadUnitKeys.includes(key))) {
    throw new ConcordError('Publish body identity must match the server change and local HEAD', 'usage');
  }
  const fences = payload.leaseFences;
  if (!fences || typeof fences !== 'object' || Array.isArray(fences) || Object.keys(fences).length !== Object.keys(expected.fences).length || Object.keys(expected.fences).length === 0 || Object.entries(expected.fences).some(([key, fence]) => fence < 1 || (fences as Record<string, unknown>)[key] !== fence)) {
    throw new ConcordError('Publish body leaseFences must match --lease-fences', 'usage');
  }
  return payload;
}
function redactRemote(remote: string): string { try { const url = new URL(remote); return `${url.origin}${url.pathname}`; } catch { return '[remote]'; } }
async function stdinText(): Promise<string> { let value = ''; for await (const chunk of process.stdin) value += chunk; return value; }
function writeOutput(stream: NodeJS.WriteStream, value: unknown): void {
  const count = { omittedMembers: 0 };
  const safe = redactOutput(value ?? null, count);
  if (count.omittedMembers && safe && typeof safe === 'object' && !Array.isArray(safe)) {
    stream.write(`${JSON.stringify({ ...safe, omittedMembers: count.omittedMembers })}\n`);
  } else {
    stream.write(`${JSON.stringify(safe)}\n`);
    if (count.omittedMembers) process.stderr.write(`${JSON.stringify({ omittedMembers: count.omittedMembers })}\n`);
  }
}
function print(value: unknown): void { writeOutput(process.stdout, value); }

for (const [name, value] of Object.entries(process.env)) {
  if (value && /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY|AUTHORIZATION)/i.test(name)) rememberCredential(value);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) runCli().catch(error => {
  const err = error instanceof ConcordError ? error : new ConcordError(error instanceof Error ? error.message : String(error), 'transport');
  const count = { omittedMembers: err.omittedMembers };
  const diagnostic: Record<string, unknown> = { error: { kind: err.kind, message: redactOutput(err.message, count), ...(err.payload === undefined ? {} : { details: redactOutput(err.payload, count) }), ...(err.status === undefined ? {} : { status: err.status }) } };
  if (count.omittedMembers) diagnostic.omittedMembers = count.omittedMembers;
  if (err.kind === 'conflict') diagnostic.nextAction = 'Inspect the current holder/version, then retry with a fresh idempotency key or renew your own active lease; leases are never stolen automatically.';
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
  process.exitCode = err.exitCode;
});
