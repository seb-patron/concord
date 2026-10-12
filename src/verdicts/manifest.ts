import type { DependencyScopeEntry, Digest, ReviewManifest, TrustedPolicy } from '../contracts';
import { declaredGenerators, generatorForFile, patternRow, prefixFileUnit, tableForFile } from '../leases/units';

const sha256 = /^sha256:[a-f0-9]{64}$/;
const oid = /^[a-f0-9]{40,64}$/;
export const compareKeys = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const unitSpec = (policy: TrustedPolicy, key: string) => policy.units[key] ?? (() => {
  if (key.startsWith('file:') && (tableForFile(policy, key.slice(5)) || prefixFileUnit(policy, key))) return {
    canonicalKey: key, file: key.slice(5), resources: [], dependencyKeys: [],
  };
  const row = patternRow(policy, key);
  return row && { canonicalKey: row.key, file: row.file, resources: [...row.resources], dependencyKeys: [] };
})();

/** JSON with object keys and review evidence arrays in a fixed order. No Worker imports. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('MANIFEST_INCOMPLETE');
  return encoded;
}

const roundConstants = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

/** Synchronous SHA-256 so coordinator hooks can verify result digests atomically. */
export function hashCanonical(value: unknown): Digest {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(length);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = BigInt(bytes.length) * 8n;
  const view = new DataView(padded.buffer);
  view.setUint32(length - 8, Number((bitLength >> 32n) & 0xffffffffn));
  view.setUint32(length - 4, Number(bitLength & 0xffffffffn));
  const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15];
      const b = words[index - 2];
      words[index] = (words[index - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + words[index - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const choice = (e & f) ^ (~e & g);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const sum1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + choice + roundConstants[index] + words[index]) >>> 0;
      const sum2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + majority) >>> 0;
      h = g; g = f; f = e; e = (d + sum1) >>> 0; d = c; c = b; b = a; a = (sum1 + sum2) >>> 0;
    }
    for (const [index, word] of [a, b, c, d, e, f, g, h].entries()) state[index] = (state[index] + word) >>> 0;
  }
  return `sha256:${state.map(word => word.toString(16).padStart(8, '0')).join('')}`;
}

function validDigest(value: unknown): value is Digest { return typeof value === 'string' && sha256.test(value); }
function validPath(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.split('/').includes('..'); }
function validMode(value: unknown): value is string { return typeof value === 'string' && /^[0-7]{6}$/.test(value); }

/** The complete transitive owner-declared dependency set for changed units. */
export function trustedDependencyKeys(policy: TrustedPolicy, changedKeys: readonly string[]): string[] {
  const visited = new Set<string>();
  const pending = [...changedKeys];
  for (const key of changedKeys) if (!unitSpec(policy, key)) throw new Error(`UNKNOWN_UNIT:${key}`);
  while (pending.length) {
    const key = pending.pop()!;
    const unit = unitSpec(policy, key);
    if (!unit || !Array.isArray(unit.dependencyKeys)) throw new Error(`UNKNOWN_DEPENDENCY:${key}`);
    const row = /^row:families:([a-z]+)$/.exec(key)?.[1];
    const generated = patternRow(policy, key);
    const reviewedRowFootprint = generated ? unit.file === generated.file &&
      JSON.stringify(unit.resources) === JSON.stringify(generated.resources) : row && unit.file === 'families.tsv' &&
      JSON.stringify(unit.resources) === JSON.stringify([`families.tsv#${row}`]);
    if (unit.canonicalKey !== key || !validPath(unit.file) || !Array.isArray(unit.resources) ||
      unit.resources.length > 0 && !reviewedRowFootprint) {
      throw new Error(`UNKNOWN_RESOURCE_SCOPE:${key}`);
    }
    for (const dependency of unit.dependencyKeys) {
      if (!unitSpec(policy, dependency)) throw new Error(`UNKNOWN_DEPENDENCY:${dependency}`);
      if (generatorForFile(policy, unitSpec(policy, dependency)!.file)) continue;
      if (!visited.has(dependency)) {
        visited.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return [...visited].sort(compareKeys);
}

/** Rejects extra fields as well as omissions, so every accepted digest has one meaning. */
export function normalizeManifest(input: ReviewManifest, policy: TrustedPolicy, expectedKeys: readonly string[]): ReviewManifest {
  if (!input || typeof input !== 'object' || !Array.isArray(input.changedUnits) || !Array.isArray(input.dependencyScope)) throw new Error('MANIFEST_INCOMPLETE');
  if (input.policyVersion !== policy.version || input.policyDigest !== policy.digest || input.checkerDigest !== policy.checkerDigest ||
    !validDigest(input.oracleDigest) || !validDigest(input.toolchainDigest)) throw new Error('MANIFEST_PIN_MISMATCH');
  const generators = declaredGenerators(policy);
  const fields = ['changedUnits', 'checkerDigest', 'coverage', 'dependencyScope', 'oracleDigest', 'policyDigest', 'policyVersion', 'toolchainDigest',
    ...(generators.length ? ['generatedOutputs'] : [])].sort().join(',');
  if (Object.keys(input).sort().join(',') !== fields) throw new Error('MANIFEST_EXTRA_FIELDS');
  let generatedOutputs: NonNullable<ReviewManifest['generatedOutputs']> | undefined;
  if (generators.length) {
    if (!Array.isArray(input.generatedOutputs) || input.generatedOutputs.length !== generators.length) throw new Error('MANIFEST_GENERATORS_INVALID');
    generatedOutputs = input.generatedOutputs.map(item => {
      if (!item || Object.keys(item).sort().join(',') !== 'id,outputDigest' ||
        typeof item.id !== 'string' || !validDigest(item.outputDigest)) throw new Error('MANIFEST_GENERATORS_INVALID');
      return { id: item.id, outputDigest: item.outputDigest };
    }).sort((a, b) => compareKeys(a.id, b.id));
    if (JSON.stringify(generatedOutputs.map(item => item.id)) !== JSON.stringify(generators.map(item => item.id).sort(compareKeys)))
      throw new Error('MANIFEST_GENERATORS_INVALID');
  }
  const keys = [...expectedKeys].sort(compareKeys);
  if (new Set(keys).size !== keys.length || !keys.length || !keys.every(key => unitSpec(policy, key))) throw new Error('UNKNOWN_UNIT_SCOPE');
  const changedUnits = input.changedUnits.map(unit => {
    if (!unit || Object.keys(unit).sort().join(',') !== 'afterDigest,afterMode,afterPath,beforeDigest,beforeMode,beforePath,unitKey' ||
      typeof unit.unitKey !== 'string' || !unitSpec(policy, unit.unitKey) ||
      !((unit.afterPath === null && unit.afterMode === null && unit.afterDigest === null) ||
        (validPath(unit.afterPath) && validMode(unit.afterMode) && validDigest(unit.afterDigest))) ||
      !((unit.beforePath === null && unit.beforeMode === null && unit.beforeDigest === null) ||
        (validPath(unit.beforePath) && validMode(unit.beforeMode) && validDigest(unit.beforeDigest))) ||
      (unit.beforePath === null && unit.afterPath === null)) throw new Error('MANIFEST_CHANGED_UNIT_INVALID');
    if (unit.afterPath !== null && unit.afterPath !== unitSpec(policy, unit.unitKey)!.file) throw new Error('MANIFEST_PATH_MISMATCH');
    return { unitKey: unit.unitKey, beforePath: unit.beforePath, afterPath: unit.afterPath,
      beforeMode: unit.beforeMode, afterMode: unit.afterMode, beforeDigest: unit.beforeDigest, afterDigest: unit.afterDigest };
  }).sort((a, b) => compareKeys(a.unitKey, b.unitKey));
  if (JSON.stringify(changedUnits.map(unit => unit.unitKey)) !== JSON.stringify(keys)) throw new Error('MANIFEST_UNIT_SCOPE_MISMATCH');
  const pins = { policyVersion: input.policyVersion, policyDigest: input.policyDigest, checkerDigest: input.checkerDigest,
    oracleDigest: input.oracleDigest, toolchainDigest: input.toolchainDigest,
    ...(generatedOutputs ? { generatedOutputs } : {}) };
  if (input.coverage === 'unknown') {
    if (input.dependencyScope.length !== 1 || input.dependencyScope[0].kind !== 'tree' ||
      Object.keys(input.dependencyScope[0]).sort().join(',') !== 'kind,treeOid' || !oid.test(input.dependencyScope[0].treeOid)) throw new Error('MANIFEST_TREE_SCOPE_INVALID');
    return { ...pins, changedUnits, coverage: 'unknown', dependencyScope: [{ kind: 'tree', treeOid: input.dependencyScope[0].treeOid }] };
  }
  if (input.coverage !== 'complete') throw new Error('MANIFEST_COVERAGE_INVALID');
  const dependencies = input.dependencyScope.map(entry => {
    if (!entry || entry.kind !== 'unit' || Object.keys(entry).sort().join(',') !== 'contentDigest,kind,mode,path,unitKey' ||
      typeof entry.unitKey !== 'string' || !unitSpec(policy, entry.unitKey) || entry.path !== unitSpec(policy, entry.unitKey)!.file ||
      !validMode(entry.mode) || !validDigest(entry.contentDigest)) throw new Error('MANIFEST_DEPENDENCY_INVALID');
    return { kind: 'unit' as const, unitKey: entry.unitKey, path: entry.path, mode: entry.mode, contentDigest: entry.contentDigest };
  }).sort((a, b) => compareKeys(a.unitKey, b.unitKey));
  if (JSON.stringify(dependencies.map(entry => entry.unitKey)) !== JSON.stringify(trustedDependencyKeys(policy, keys))) throw new Error('MANIFEST_DEPENDENCY_SCOPE_MISMATCH');
  return { ...pins, changedUnits, coverage: 'complete', dependencyScope: dependencies };
}

export function manifestDigest(input: ReviewManifest, policy: TrustedPolicy, expectedKeys: readonly string[]): Digest {
  return hashCanonical(normalizeManifest(input, policy, expectedKeys));
}

export function dependencyScopeDigest(scope: DependencyScopeEntry[]): Digest {
  const sorted = [...scope].sort((a, b) => compareKeys(a.kind === 'unit' ? a.unitKey : a.treeOid, b.kind === 'unit' ? b.unitKey : b.treeOid));
  return hashCanonical(sorted);
}
