/** Counterfactual lease overlap, not measured simultaneous work or Git merge failures. */
import { commit, git, mapDiff } from './extract-ts-units.ts';
import type { Footprint } from './extract-ts-units.ts';

const ref = commit(process.argv[2] ?? 'origin/main');
const count = Number(process.argv[3] ?? 12);
if (!Number.isSafeInteger(count) || count < 2 || count > 50) throw new Error('Use a history window from 2 through 50');
const merges = git(['log', '--first-parent', '--merges', `-${count}`, '--format=%H%x09%s', ref, '--'])
  .trim().split('\n').filter(Boolean).map(line => {
    const [oid, subject] = line.split('\t');
    const base = commit(`${oid}^1`);
    return { oid, label: /#\d+/.exec(subject)?.[0] ?? oid.slice(0, 7), units: mapDiff(base, oid) };
  });
function conflicts(a: Footprint[], b: Footprint[], symbols: boolean, tsOnly: boolean): boolean {
  return a.some(left => (!tsOnly || /\.(?:ts|tsx|mts|cts)$/.test(left.path)) && b.some(right => {
    if (left.path !== right.path) return false;
    return !symbols || left.units.includes(`file:${left.path}`) || right.units.includes(`file:${right.path}`) ||
      left.units.some(key => right.units.includes(key));
  }));
}
console.log(`history_ref=${ref} requested_merges=${count} sampled_merges=${merges.length}`);
for (const item of merges) console.log(`${item.label} ${item.oid.slice(0, 7)} files=${item.units.length} narrow_ts_files=${item.units.filter(unit => unit.reason === 'named-declaration-bytes').length}`);
for (const adjacent of [false, true]) {
  let pairs = 0, files = 0, symbols = 0, tsFiles = 0, tsSymbols = 0;
  const avoided: string[] = [];
  for (let i = 0; i < merges.length; i++) for (let j = i + 1; j < merges.length; j++) {
    if (adjacent && j !== i + 1) continue;
    pairs++;
    const a = merges[i], b = merges[j];
    const file = conflicts(a.units, b.units, false, false), symbol = conflicts(a.units, b.units, true, false);
    files += Number(file); symbols += Number(symbol);
    tsFiles += Number(conflicts(a.units, b.units, false, true));
    tsSymbols += Number(conflicts(a.units, b.units, true, true));
    if (file && !symbol) avoided.push(`${a.label}/${b.label}`);
  }
  console.log(`${adjacent ? 'adjacent' : 'all_pairs'} pairs=${pairs} file_conflicts=${files} symbol_conflicts=${symbols} ts_file_conflicts=${tsFiles} ts_symbol_conflicts=${tsSymbols}`);
  console.log(`avoided_pairs=${avoided.join(',') || '(none)'}`);
}
