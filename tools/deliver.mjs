import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isRealDate,
  letterId,
  parseFrontmatter,
  readMailbox,
  residentHandles,
  stampDelivery,
} from './lib.mjs';

// Carries every letter waiting in an outbox to its recipient. Safe to rerun:
// a letter is only removed from the outbox once both delivered copies exist.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

const handles = residentHandles(ROOT);
const town = new Set(handles);
const carried = [];
const refused = [];

for (const handle of handles) {
  for (const letter of readMailbox(ROOT, handle, 'outbox')) {
    const rel = `residents/${handle}/outbox/${letter.name}`;
    const text = readFileSync(letter.path, 'utf8');

    let fields;
    try { fields = parseFrontmatter(text, rel).fields; }
    catch (error) { refused.push(`${rel}: ${error.message}`); continue; }

    // Thaw re-checks the letter rather than trusting that a gate ran.
    const problems = [];
    for (const field of ['id', 'from', 'to', 'date', 'subject']) {
      if (!fields[field]) problems.push(`required field "${field}" is empty`);
    }
    if (!problems.length) {
      if (fields.id !== letter.id) problems.push(`id "${fields.id}" does not match the filename`);
      if (fields.from !== handle) problems.push(`from "${fields.from}" is not this outbox's resident`);
      if (fields.from === fields.to) problems.push('a letter must cross between two different homes');
      if (!town.has(fields.to)) problems.push(`no resident "${fields.to}" lives in Verglas`);
      if (!isRealDate(fields.date)) problems.push('date must be a real date in YYYY-MM-DD form');
      else {
        const prefix = letterId(fields.date, fields.from, fields.to, '');
        if (!letter.id.startsWith(prefix) || letter.id === prefix) {
          problems.push('id must read <date>-<from>-to-<to>-<slug>');
        }
      }
      if (fields.delivered || fields.delivered_by) problems.push('only Thaw adds delivered and delivered_by');
    }

    if (problems.length) {
      refused.push(`${rel}: ${problems[0]}`);
      continue;
    }

    const inbox = join(ROOT, 'residents', fields.to, 'inbox', letter.name);
    const sent = join(ROOT, 'residents', fields.from, 'sent', letter.name);
    if (existsSync(inbox) || existsSync(sent)) {
      refused.push(`${rel}: a letter with this id has already been delivered`);
      continue;
    }

    if (dryRun) {
      carried.push(`${fields.from} → ${fields.to}: ${letter.id}`);
      continue;
    }

    // Write both copies before removing the outbox original, so an
    // interrupted run leaves the letter waiting rather than lost.
    const delivered = stampDelivery(text);
    for (const target of [inbox, sent]) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, delivered);
    }
    rmSync(letter.path);
    carried.push(`${fields.from} → ${fields.to}: ${letter.id}`);
  }
}

for (const letter of carried) console.log(`${dryRun ? 'would carry' : 'carried'}  ${letter}`);
for (const problem of refused) console.error(`REFUSED ${problem}`);

if (refused.length) {
  console.error(`\n${refused.length} letter(s) stayed in the outbox.`);
  process.exit(1);
}

console.log(`${dryRun ? 'Would carry' : 'Carried'} ${carried.length} letter(s).`);
