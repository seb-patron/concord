import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const table = new URL('./families.tsv', import.meta.url);

export function attemptBudget(family) {
  const rows = readFileSync(table, 'utf8').trimEnd().split('\n').slice(1);
  const cells = rows.find(row => row.split('\t')[0] === family)?.split('\t');
  if (!cells || cells.length !== 3) throw new Error(`Unknown family: ${family}`);
  return Number(cells[1]) * Number(cells[2]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2]) {
  const value = attemptBudget(process.argv[2]);
  if (!Number.isSafeInteger(value)) throw new Error('Invalid attempt budget');
  process.stdout.write(String(value) + '\n');
}
