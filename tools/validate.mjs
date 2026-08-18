import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADDRESS_LIMIT,
  DELIVERED_BOXES,
  DELIVERY_FIELDS,
  HANDLE_PATTERN,
  PUBKEY_PATTERN,
  TOWNKEEPERS,
  allLetters,
  drawingProblem,
  isRealDate,
  letterId,
  normalizeGithubLogin,
  parseDrawings,
  readFrontmatter,
  residentHandles,
} from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const fail = (file, message) => errors.push(`${file}: ${message}`);
const warn = (file, message) => warnings.push(`${file}: ${message}`);

const allowedExtensions = new Set(['.md', '.txt', '.png', '.jpg', '.jpeg', '.webp', '.gif']);
const requiredAddress = ['handle', 'name', 'household', 'github', 'joined'];
const requiredHome = ['resident', 'title', 'location'];
const requiredLetter = ['id', 'from', 'to', 'date', 'subject'];

function walk(directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...walk(path));
    else paths.push(path);
  }
  return paths;
}

const handles = residentHandles(ROOT);
const town = new Set(handles);

/** Which folders each account holds, tallied as the addresses are read. */
const heldBy = new Map();

// ── Addresses and homes ───────────────────────────────────────────────────

for (const handle of handles) {
  const folder = join(ROOT, 'residents', handle);
  const addressPath = join(folder, 'ADDRESS.md');
  const homePath = join(folder, 'HOME.md');
  const addressRel = relative(ROOT, addressPath);
  const homeRel = relative(ROOT, homePath);

  if (!HANDLE_PATTERN.test(handle)) fail(`residents/${handle}`, 'folder name is not a valid handle');
  if (!existsSync(addressPath)) fail(addressRel, 'missing ADDRESS.md');
  if (!existsSync(homePath)) fail(homeRel, 'missing HOME.md');
  if (!existsSync(addressPath) || !existsSync(homePath)) continue;

  let address;
  let home;
  try { address = readFrontmatter(addressPath).fields; }
  catch (error) { fail(addressRel, error.message); continue; }
  try { home = readFrontmatter(homePath).fields; }
  catch (error) { fail(homeRel, error.message); continue; }

  for (const field of requiredAddress) {
    if (!address[field]) fail(addressRel, `required field "${field}" is empty`);
  }
  for (const field of requiredHome) {
    if (!home[field]) fail(homeRel, `required field "${field}" is empty`);
  }

  if (address.handle && address.handle !== handle) {
    fail(addressRel, `handle "${address.handle}" does not match folder "${handle}"`);
  }
  if (home.resident && home.resident !== handle) {
    fail(homeRel, `resident "${home.resident}" does not match folder "${handle}"`);
  }
  if (address.handle && !HANDLE_PATTERN.test(address.handle)) {
    fail(addressRel, 'handle must be lowercase words separated by single hyphens');
  }
  if (address.github && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(normalizeGithubLogin(address.github))) {
    fail(addressRel, 'github is not shaped like a GitHub login');
  }
  if (address.github) {
    const account = normalizeGithubLogin(address.github);
    heldBy.set(account, [...(heldBy.get(account) ?? []), handle]);
  }
  if (address.joined && !isRealDate(address.joined)) {
    fail(addressRel, 'joined must be a real date in YYYY-MM-DD form');
  }
  if (address.note && address.note.length > 180) {
    warn(addressRel, 'note is longer than 180 characters');
  }
  // Optional. A public key and a private key are both 64 hex characters, so
  // shape is all that can be checked here — nothing can tell them apart.
  if (address.key && !PUBKEY_PATTERN.test(address.key.trim().toLowerCase())) {
    fail(addressRel, 'key must be an Ed25519 public key: 64 hexadecimal characters');
  }

  if (home.image) {
    if (home.image.startsWith('/') || home.image.includes('..')) {
      fail(homeRel, 'image must be a safe relative path inside the resident folder');
    } else if (!existsSync(join(folder, home.image))) {
      fail(homeRel, `image points to missing file "${home.image}"`);
    }
  }

  for (const path of walk(folder)) {
    const rel = relative(ROOT, path).replaceAll('\\', '/');
    if (path.endsWith('.gitkeep')) continue;
    const extension = extname(path).toLowerCase();
    if (!allowedExtensions.has(extension)) {
      fail(rel, `file type "${extension || '(none)'}" is not allowed`);
    }
    if (statSync(path).size > 1_500_000) {
      fail(rel, 'file is larger than 1.5 MB');
    }
  }
}

// ── Letters ───────────────────────────────────────────────────────────────

/** Which boxes each ID occupies. A crossing writes inbox and sent together. */
const seen = new Map();
const replies = [];

for (const letter of allLetters(ROOT, handles)) {
  const rel = relative(ROOT, letter.path).replaceAll('\\', '/');

  let fields;
  try { fields = readFrontmatter(letter.path).fields; }
  catch (error) { fail(rel, error.message); continue; }

  for (const field of requiredLetter) {
    if (!fields[field]) fail(rel, `required field "${field}" is empty`);
  }
  if (requiredLetter.some((field) => !fields[field])) continue;

  if (fields.id !== letter.id) {
    fail(rel, `id "${fields.id}" does not match the filename`);
  }
  if (!isRealDate(fields.date)) {
    fail(rel, 'date must be a real date in YYYY-MM-DD form');
  } else {
    const prefix = letterId(fields.date, fields.from, fields.to, '');
    if (!letter.id.startsWith(prefix) || letter.id === prefix) {
      fail(rel, 'id must read <date>-<from>-to-<to>-<slug>');
    }
  }

  if (!town.has(fields.from)) fail(rel, `sender "${fields.from}" does not live in Verglas`);
  if (!town.has(fields.to)) fail(rel, `recipient "${fields.to}" does not live in Verglas`);
  if (fields.from === fields.to) fail(rel, 'a letter must cross between two different homes');

  // A letter sits in the sender's outbox and sent, and the recipient's inbox.
  const owner = letter.box === 'inbox' ? fields.to : fields.from;
  if (owner !== letter.handle) {
    fail(rel, `this box belongs to "${letter.handle}", but the letter is ${letter.box === 'inbox' ? 'addressed to' : 'from'} "${owner}"`);
  }

  // A letter may carry drawings out of the sender's own assets/ folder. The
  // names are checked everywhere; where the files must be depends on how far
  // the letter has travelled. Before it is sent, the sender must actually hold
  // them — assets cannot ride along in a letter's pull request, so they have to
  // arrive in an earlier one. After delivery the recipient should hold them
  // too, but that is a warning: an older letter predates the field, and a
  // resident's own assets are theirs to tend.
  for (const name of parseDrawings(fields.drawings)) {
    const problem = drawingProblem(name);
    if (problem) { fail(rel, `drawing ${problem}`); continue; }

    if (!existsSync(join(ROOT, 'residents', fields.from, 'assets', name))) {
      fail(rel, `drawing "${name}" is not in residents/${fields.from}/assets`);
    }
    if (DELIVERED_BOXES.includes(letter.box) &&
        !existsSync(join(ROOT, 'residents', fields.to, 'assets', name))) {
      warn(rel, `delivered drawing "${name}" has not reached residents/${fields.to}/assets`);
    }
  }

  const receipted = DELIVERY_FIELDS.filter((field) => fields[field]);
  if (letter.box === 'outbox' && receipted.length) {
    fail(rel, `only Thaw adds ${receipted.join(' and ')}; remove it before sending`);
  }
  if (DELIVERED_BOXES.includes(letter.box) && receipted.length !== DELIVERY_FIELDS.length) {
    fail(rel, `a delivered letter must carry ${DELIVERY_FIELDS.join(' and ')}`);
  }

  if (!seen.has(letter.id)) seen.set(letter.id, []);
  seen.get(letter.id).push({ box: letter.box, rel });
  if (fields.reply_to) replies.push({ rel, to: fields.reply_to });
}

for (const [id, copies] of seen) {
  const boxes = copies.map((copy) => copy.box).sort();
  const shape = boxes.join('+');
  // In flight, or delivered. Nothing else is a legitimate resting place.
  if (shape !== 'outbox' && shape !== 'inbox+sent') {
    fail(copies[0].rel, `letter "${id}" is in ${shape}; a letter waits in outbox, or rests in inbox and sent`);
  }
}

for (const reply of replies) {
  if (!seen.has(reply.to)) warn(reply.rel, `reply_to "${reply.to}" is not a letter in town`);
}

// ── The address ceiling ───────────────────────────────────────────────────
// The gate in lib.mjs stops one account taking a fourth plot as it arrives.
// This is the same rule stated about the whole town, so a merge that got in
// another way still shows up here rather than passing quietly.

for (const [account, held] of [...heldBy].sort()) {
  if (TOWNKEEPERS.includes(account) || held.length <= ADDRESS_LIMIT) continue;
  fail(
    'residents',
    `GitHub account "${account}" holds ${held.length} addresses (${held.sort().join(', ')}); ` +
    `the town allows ${ADDRESS_LIMIT}`,
  );
}

// ── Report ────────────────────────────────────────────────────────────────

for (const warning of warnings.sort()) console.warn(`WARN  ${warning}`);
for (const error of errors.sort()) console.error(`ERROR ${error}`);

if (errors.length) {
  console.error(`\nValidation failed with ${errors.length} error(s) and ${warnings.length} warning(s).`);
  process.exit(1);
}

console.log(
  `Validation passed for ${handles.length} resident(s) and ${seen.size} letter(s) ` +
  `with ${warnings.length} warning(s).`
);
