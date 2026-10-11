#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TrustedPolicy } from '../src/contracts';
import { hashCanonical } from '../src/verdicts/manifest';
import { unitRegistry } from '../src/leases/units';

export const GENERATOR_VERSION = 1;
const oidPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

type PolicyTemplate = TrustedPolicy & Record<string, unknown>;
interface Options {
  repo: string; template: string; oid?: string; readBackOid?: string;
  allowPaths: string[]; pathFiles: string[]; compareFile?: string;
}

function fail(message: string): never { throw new Error(message); }

function validPath(path: string): void {
  if (!path || path.length > 512 || `file:${path}`.length > 512 || path.startsWith('/') ||
    path.includes('\\') || /[\s\0]/u.test(path) ||
    path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git') ||
    path.normalize('NFC') !== path) fail(`UNSAFE_PATH: ${JSON.stringify(path)}`);
}

function key(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\s\0]/u.test(value)) {
    fail(`INVALID_${label}: ${JSON.stringify(value)}`);
  }
}

function validateRegistry(policy: TrustedPolicy, label: string): void {
  try { unitRegistry(policy); }
  catch (error) {
    const partial: TrustedPolicy['units'] = {};
    for (const [alias, unit] of Object.entries(policy.units)) {
      partial[alias] = unit;
      try { unitRegistry({ ...policy, units: partial }); }
      catch { fail(`${label}: ${alias}: ${(error as Error).message}`); }
    }
    fail(`${label}: ${(error as Error).message}`);
  }
}

function parseArgs(argv: string[]): Options {
  const options: Options = { repo: '', template: '', allowPaths: [], pathFiles: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--repo', '--template', '--oid', '--read-back-oid', '--allow-path', '--allow-path-file', '--compare'].includes(flag)) {
      fail(`UNKNOWN_ARGUMENT: ${flag}`);
    }
    const value = argv[++i];
    if (!value) fail(`MISSING_ARGUMENT: ${flag}`);
    switch (flag) {
      case '--repo': if (options.repo) fail('DUPLICATE_ARGUMENT: --repo'); options.repo = value; break;
      case '--template': if (options.template) fail('DUPLICATE_ARGUMENT: --template'); options.template = value; break;
      case '--oid': if (options.oid) fail('DUPLICATE_ARGUMENT: --oid'); options.oid = value; break;
      case '--read-back-oid': if (options.readBackOid) fail('DUPLICATE_ARGUMENT: --read-back-oid'); options.readBackOid = value; break;
      case '--allow-path': options.allowPaths.push(value); break;
      case '--allow-path-file': options.pathFiles.push(value); break;
      case '--compare': if (options.compareFile) fail('DUPLICATE_ARGUMENT: --compare'); options.compareFile = value; break;
    }
  }
  if (!options.repo || !options.template) fail('REQUIRED_ARGUMENTS: --repo and --template');
  if (options.compareFile ? (!options.readBackOid || options.oid) : (!options.oid || options.readBackOid)) {
    fail('OID_ARGUMENTS: use --oid, or --compare with --read-back-oid');
  }
  const oid = options.oid ?? options.readBackOid;
  if (!oidPattern.test(oid!)) fail(`INVALID_OID: ${oid}`);
  return options;
}

function git(repo: string, args: string[]): Buffer {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } });
  } catch (error) {
    const detail = error as { stderr?: Buffer; message?: string };
    fail(`GIT_READ_FAILED: ${args[0]}: ${detail.stderr?.toString('utf8').trim() || detail.message}`);
  }
}

function trackedPaths(repo: string, oid: string): string[] {
  const kind = git(repo, ['cat-file', '-t', oid]).toString('ascii').trim();
  if (kind !== 'commit') fail(`NOT_A_COMMIT: ${oid} (${kind})`);
  const raw = git(repo, ['ls-tree', '-r', '-z', '--full-tree', oid]);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const paths: string[] = [];
  for (const entry of raw.subarray(0, raw.length ? raw.length - 1 : 0).toString('binary').split('\0')) {
    if (!entry) continue;
    let decoded: string;
    try { decoded = decoder.decode(Buffer.from(entry, 'binary')); }
    catch { fail('UNSUPPORTED_GIT_PATH_ENCODING'); }
    const match = /^(\d{6}) (\w+) [a-f0-9]{40,64}\t(.*)$/su.exec(decoded);
    if (!match) fail(`MALFORMED_TREE_ENTRY: ${JSON.stringify(decoded)}`);
    const [, mode, type, path] = match;
    validPath(path);
    if (!['100644', '100755'].includes(mode) || type !== 'blob') {
      fail(`UNSUPPORTED_TREE_ENTRY: ${JSON.stringify(path)} (${mode} ${type})`);
    }
    paths.push(path);
  }
  if (raw.length && raw[raw.length - 1] !== 0) fail('MALFORMED_TREE_TERMINATOR');
  return paths;
}

function plannedPaths(options: Options): string[] {
  const paths = [...options.allowPaths];
  for (const file of options.pathFiles) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) paths.push(line.endsWith('\r') ? line.slice(0, -1) : line);
  }
  for (const path of paths) validPath(path);
  return paths;
}

function templateFrom(file: string): PolicyTemplate {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_TEMPLATE: expected policy object');
  const policy = value as PolicyTemplate;
  key(policy.id, 'POLICY_ID');
  key(policy.checkerId, 'CHECKER_ID');
  if (!Number.isSafeInteger(policy.version) || policy.version < 1 || !digestPattern.test(policy.checkerDigest) ||
    !policy.acceptance || typeof policy.acceptance !== 'object' ||
    !policy.units || typeof policy.units !== 'object' || Array.isArray(policy.units)) {
    fail('INVALID_TEMPLATE: required policy fields');
  }
  const acceptance = policy.acceptance;
  if (!['hard-gates', 'score'].includes(acceptance.kind) || !Array.isArray(acceptance.gates) ||
    acceptance.gates.length === 0 || !acceptance.gates.every(gate => gate && typeof gate.id === 'string' &&
      gate.id.length > 0 && ['MATCH', 'PASS'].includes(gate.requiredOutcome)) ||
    (acceptance.kind === 'score' && (!Number.isSafeInteger(acceptance.fixedDenominator) || acceptance.fixedDenominator <= 0))) {
    fail('INVALID_TEMPLATE: acceptance');
  }
  if (policy.digest !== undefined && !digestPattern.test(policy.digest)) fail('INVALID_TEMPLATE: digest');
  // Existing entries (including future table metadata) remain byte-for-byte equivalent as JSON values.
  for (const [alias, unit] of Object.entries(policy.units)) {
    key(alias, 'UNIT_KEY');
    if (!unit || typeof unit !== 'object' || Array.isArray(unit)) fail(`INVALID_UNIT: ${alias}`);
    key(unit.canonicalKey, 'CANONICAL_KEY');
    validPath(unit.file);
    if (!Array.isArray(unit.resources) || !unit.resources.every(resource => typeof resource === 'string') ||
      !Array.isArray(unit.dependencyKeys) || !unit.dependencyKeys.every(dependency => typeof dependency === 'string')) {
      fail(`INVALID_UNIT: ${alias}`);
    }
  }
  validateRegistry(policy, 'AMBIGUOUS_TEMPLATE_METADATA');
  return policy;
}

function generate(options: Options): { sourceOid: string; generatorVersion: number; policy: PolicyTemplate; policyDigest: string } {
  const oid = (options.oid ?? options.readBackOid)!;
  const tracked = trackedPaths(options.repo, oid);
  const paths = [...new Set([...tracked, ...plannedPaths(options)])].sort(compare);
  const pathSet = new Set(paths);
  for (const path of paths) {
    let slash = path.indexOf('/');
    while (slash !== -1) {
      const ancestor = path.slice(0, slash);
      if (pathSet.has(ancestor)) fail(`PATH_CONFLICT: ${JSON.stringify(ancestor)} and ${JSON.stringify(path)}`);
      slash = path.indexOf('/', slash + 1);
    }
  }
  const template = templateFrom(options.template);
  for (const [alias, unit] of Object.entries(template.units)) {
    if (!pathSet.has(unit.file)) fail(`UNAPPROVED_TEMPLATE_PATH: ${alias} -> ${JSON.stringify(unit.file)}`);
  }
  const units = { ...template.units };
  for (const path of paths) {
    const alias = `file:${path}`;
    const existing = units[alias];
    if (existing) {
      if (existing.canonicalKey !== alias || existing.file !== path) fail(`AMBIGUOUS_FILE_UNIT: ${alias}`);
    } else {
      units[alias] = { canonicalKey: alias, file: path, resources: [], dependencyKeys: [] };
    }
  }
  for (const [alias, unit] of Object.entries(units)) {
    for (const dependency of unit.dependencyKeys) {
      if (!Object.hasOwn(units, dependency)) fail(`MISSING_DEPENDENCY: ${alias} -> ${dependency}`);
    }
  }
  validateRegistry({ ...template, units }, 'AMBIGUOUS_GENERATED_METADATA');
  const { digest: _oldDigest, ...withoutDigest } = { ...template, units };
  const digest = hashCanonical(withoutDigest);
  const policy = { ...withoutDigest, digest };
  return { sourceOid: oid, generatorVersion: GENERATOR_VERSION, policy, policyDigest: digest };
}

export function main(argv: string[]): number {
  const options = parseArgs(argv);
  const envelope = generate(options);
  if (options.compareFile) {
    const previous: unknown = JSON.parse(readFileSync(options.compareFile, 'utf8'));
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) fail('INVALID_COMPARISON_ENVELOPE');
    const prior = previous as Record<string, unknown>;
    if (!prior.policy || typeof prior.policy !== 'object' || Array.isArray(prior.policy) ||
      prior.policyDigest !== (prior.policy as Record<string, unknown>).digest ||
      prior.policyDigest !== hashCanonical(Object.fromEntries(Object.entries(prior.policy).filter(([key]) => key !== 'digest')))) {
      fail('INVALID_COMPARISON_ENVELOPE: digest mismatch');
    }
    const status = prior.policyDigest === envelope.policyDigest ? 'unchanged' : 'changed';
    process.stdout.write(JSON.stringify({ status, ...envelope }) + '\n');
    return status === 'unchanged' ? 0 : 1;
  }
  process.stdout.write(JSON.stringify(envelope) + '\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error((error as Error).message); process.exitCode = 2; }
}
