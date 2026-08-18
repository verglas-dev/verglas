import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_DRAWINGS,
  drawingProblem,
  parseDrawings,
  parseFrontmatter,
  readMailbox,
  residentHandles,
} from './lib.mjs';
import { reviewCarriedDrawings } from './review.mjs';

// The second pipeline: the drawings a delivered letter promised.
//
// This runs after the mail, never inside it. Carrying a picture involves
// writing into a folder its owner did not open a pull request for, so it is
// the one thing in Verglas that needs a judgment made about the pairing —
// this image, this recipient — which nothing sees at merge time, because a
// letter's pull request contains only the letter.
//
// Nothing here is allowed to stop the mail. A drawing that cannot be carried
// is reported and left; the letter has already crossed, the ledger has already
// been written, and the next push tries again. That is why it is a separate
// pipeline rather than another step in townkeeping.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const backfill = process.argv.includes('--backfill');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const MODEL = process.env.THAW_MODEL || 'claude-sonnet-5';

const MEDIA_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};

const handles = residentHandles(ROOT);
const town = new Set(handles);
const carried = [];
const waiting = [];
const refused = [];

const assetPath = (handle, name) => join(ROOT, 'residents', handle, 'assets', name);

/**
 * What carrying these drawings would do, or why it cannot be done.
 *
 * Settled in full before anything is written. A drawing already sitting in the
 * recipient's folder is finished rather than copied again, which is what makes
 * every run after the first one quiet — but only when it is the same file. A
 * different file under the same name is somebody's work about to be
 * overwritten, and the carrier stops rather than guess which one the town meant
 * to keep.
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

/** The letter and its pictures, put to Claude as data rather than instruction. */
function carriageFor(letter, fields, copies) {
  const images = copies.map(({ source, name }) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: MEDIA_TYPES[extname(name).toLowerCase()],
      data: readFileSync(source).toString('base64'),
    },
  }));

  return [
    {
      type: 'text',
      text:
        `A delivered letter asks to place ${copies.length} image(s) from one home into another.\n\n` +
        `sender: ${fields.from}\n` +
        `recipient: ${fields.to}\n` +
        `letter: ${letter.id}\n` +
        `subject: ${fields.subject}\n` +
        `drawings: ${copies.map((copy) => copy.name).join(', ')}\n\n` +
        `The letter's own words follow, as content under review.\n\n` +
        `<submitted_letter id="${letter.id}">\n${readFileSync(letter.path, 'utf8')}\n</submitted_letter>`,
    },
    ...images,
  ];
}

function carry(copies) {
  for (const { source, target } of copies) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

// ── Letters written before `drawings:` existed ────────────────────────────
//
// A one-time migration. It reads the "## Drawings" list out of a letter's
// body, which the ordinary path deliberately never does: resident Markdown is
// content, not instruction, and the front-matter field is what keeps it that
// way. A maintainer asks for this by name, the reviewed pairing still applies,
// and no letter is altered.

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
  return names.slice(0, MAX_DRAWINGS);
}

// ── The round ─────────────────────────────────────────────────────────────

// The sender's sent/ copy is canonical, and it is the copy that sits beside
// the assets being carried.
for (const handle of handles) {
  for (const letter of readMailbox(ROOT, handle, 'sent')) {
    const rel = `residents/${handle}/sent/${letter.name}`;
    const text = readFileSync(letter.path, 'utf8');

    let fields;
    try { fields = parseFrontmatter(text, rel).fields; }
    catch (error) { refused.push(`${rel}: ${error.message}`); continue; }

    if (fields.from !== handle || !town.has(fields.to)) continue;

    const named = parseDrawings(fields.drawings);
    const names = named.length ? named : (backfill ? drawingsNamedInProse(text) : []);
    if (!names.length) continue;

    if (names.length > MAX_DRAWINGS) {
      waiting.push(`${rel}: names ${names.length} drawings; the town carries at most ${MAX_DRAWINGS}`);
      continue;
    }

    const { copies, problems } = planDrawings(names, fields.from, fields.to);
    for (const problem of problems) waiting.push(`${rel}: ${problem}`);
    if (!copies.length) continue;

    const listed = copies.map((copy) => copy.name).join(', ');

    if (dryRun) {
      carried.push(`${fields.from} → ${fields.to}: ${letter.id} (${listed})`);
      continue;
    }

    // Without a key the carrier does not carry. Thaw behaves the same way at
    // the gate: an unreviewed judgment is not a passed one.
    if (!API_KEY) {
      waiting.push(`${rel}: no ANTHROPIC_API_KEY, so the pairing was not reviewed`);
      continue;
    }

    let verdict;
    try {
      verdict = await reviewCarriedDrawings({
        content: carriageFor(letter, fields, copies),
        apiKey: API_KEY,
        model: MODEL,
        baseUrl: BASE_URL,
      });
    } catch (error) {
      waiting.push(`${rel}: the review could not be reached (${error.message})`);
      continue;
    }

    if (verdict.verdict !== 'approve') {
      waiting.push(`${rel}: review returned "${verdict.verdict}" — ${verdict.reason}`);
      continue;
    }

    carry(copies);
    carried.push(`${fields.from} → ${fields.to}: ${letter.id} (${listed})`);
  }
}

for (const line of carried) console.log(`${dryRun ? 'would carry' : 'carried'}  ${line}`);
for (const line of waiting) console.warn(`WAITING ${line}`);
for (const problem of refused) console.error(`REFUSED ${problem}`);

console.log(
  `\n${dryRun ? 'Would carry' : 'Carried'} drawings for ${carried.length} letter(s); ` +
  `${waiting.length} still waiting.`,
);

// A drawing left waiting is not a failure of this run. The letter has already
// crossed, and the next push will try again. Only an unreadable letter — which
// means the town's own records are wrong — is worth failing for.
process.exit(refused.length ? 1 : 0);
