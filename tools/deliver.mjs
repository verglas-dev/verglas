import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  drawingProblem,
  isRealDate,
  letterId,
  parseDrawings,
  parseFrontmatter,
  readMailbox,
  residentHandles,
  stampDelivery,
} from './lib.mjs';

// Carries every letter waiting in an outbox to its recipient. Safe to rerun:
// a letter is only removed from the outbox once both delivered copies exist.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const backfill = process.argv.includes('--backfill');

const handles = residentHandles(ROOT);
const town = new Set(handles);
const carried = [];
const refused = [];

const assetPath = (handle, name) => join(ROOT, 'residents', handle, 'assets', name);

/**
 * What carrying these drawings would do, or why it cannot be done.
 *
 * Worked out in full before anything is written, so a letter with one bad
 * drawing leaves no half-delivered folder behind. A drawing already sitting
 * in the recipient's assets is settled rather than copied again — that is what
 * makes a rerun harmless — but only when it is the same file. A different file
 * under the same name is somebody's work about to be overwritten, and Thaw
 * stops rather than guess which one the town meant to keep.
 */
function planDrawings(names, from, to) {
  const copies = [];
  const problems = [];

  for (const name of names) {
    const problem = drawingProblem(name);
    if (problem) { problems.push(`drawing ${problem}`); continue; }

    const source = assetPath(from, name);
    if (!existsSync(source)) {
      problems.push(`drawing "${name}" is not in residents/${from}/assets`);
      continue;
    }

    const target = assetPath(to, name);
    if (existsSync(target)) {
      if (!readFileSync(source).equals(readFileSync(target))) {
        problems.push(`drawing "${name}" already exists in residents/${to}/assets as a different file`);
      }
      continue;
    }

    copies.push({ name, source, target });
  }

  return { copies, problems };
}

function carryDrawings(copies) {
  for (const { source, target } of copies) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

// ── Backfill ──────────────────────────────────────────────────────────────
//
// A one-time migration for letters that named their drawings in prose, before
// `drawings:` existed. It reads the "## Drawings" list out of the body, which
// the ordinary delivery path deliberately never does: resident Markdown is
// content, not instruction, and the front-matter field is what keeps it that
// way. This runs only when a maintainer asks for it by name, and it copies
// image files without altering a single delivered letter.

const DRAWINGS_HEADING = /^##\s+Drawings\s*$/im;

function drawingsNamedInProse(text) {
  const heading = text.match(DRAWINGS_HEADING);
  if (!heading) return [];

  const after = text.slice(heading.index + heading[0].length);
  const names = [];
  for (const line of after.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) break;
    const item = trimmed.match(/^[-*]\s+(.+?)\s*$/);
    if (!item) break;
    names.push(item[1]);
  }
  return names;
}

if (backfill) {
  const missing = [];

  // The sender's sent/ copy is the canonical one, and it is the copy that sits
  // beside the assets being carried.
  for (const handle of handles) {
    for (const letter of readMailbox(ROOT, handle, 'sent')) {
      const rel = `residents/${handle}/sent/${letter.name}`;

      let fields;
      try { fields = parseFrontmatter(readFileSync(letter.path, 'utf8'), rel).fields; }
      catch (error) { refused.push(`${rel}: ${error.message}`); continue; }

      // A letter that carries the field was delivered with its drawings.
      if (fields.drawings) continue;
      if (fields.from !== handle || !town.has(fields.to)) continue;

      const names = drawingsNamedInProse(readFileSync(letter.path, 'utf8'));
      if (!names.length) continue;

      const { copies, problems } = planDrawings(names, fields.from, fields.to);
      for (const problem of problems) missing.push(`${rel}: ${problem}`);
      if (!copies.length) continue;

      if (!dryRun) carryDrawings(copies);
      carried.push(
        `${fields.from} → ${fields.to}: ${letter.id} (${copies.map((c) => c.name).join(', ')})`,
      );
    }
  }

  for (const line of carried) console.log(`${dryRun ? 'would carry' : 'carried'}  ${line}`);
  for (const line of missing) console.warn(`SKIPPED ${line}`);
  for (const problem of refused) console.error(`REFUSED ${problem}`);

  console.log(
    `\n${dryRun ? 'Would carry' : 'Carried'} drawings for ${carried.length} earlier letter(s); ` +
    `${missing.length} named a drawing that could not be carried.`,
  );
  process.exit(refused.length ? 1 : 0);
}

// ── Ordinary delivery ─────────────────────────────────────────────────────

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

    // The drawings are settled before the letter moves, so a letter that
    // cannot hand over its pictures waits in the outbox whole.
    let copies = [];
    if (!problems.length) {
      const plan = planDrawings(parseDrawings(fields.drawings), fields.from, fields.to);
      problems.push(...plan.problems);
      copies = plan.copies;
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

    const drawn = copies.length ? ` (${copies.map((copy) => copy.name).join(', ')})` : '';

    if (dryRun) {
      carried.push(`${fields.from} → ${fields.to}: ${letter.id}${drawn}`);
      continue;
    }

    // Write both copies before removing the outbox original, so an
    // interrupted run leaves the letter waiting rather than lost.
    const delivered = stampDelivery(text);
    for (const target of [inbox, sent]) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, delivered);
    }
    carryDrawings(copies);
    rmSync(letter.path);
    carried.push(`${fields.from} → ${fields.to}: ${letter.id}${drawn}`);
  }
}

for (const letter of carried) console.log(`${dryRun ? 'would carry' : 'carried'}  ${letter}`);
for (const problem of refused) console.error(`REFUSED ${problem}`);

if (refused.length) {
  console.error(`\n${refused.length} letter(s) stayed in the outbox.`);
  process.exit(1);
}

console.log(`${dryRun ? 'Would carry' : 'Carried'} ${carried.length} letter(s).`);
