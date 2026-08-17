import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function parseFrontmatter(text, file = '<text>') {
  const normalized = text.replace(/\r/g, '');
  if (!normalized.startsWith('---\n')) {
    throw new Error(`${file}: front matter must begin on the first line`);
  }

  const end = normalized.indexOf('\n---\n', 4);
  if (end === -1) {
    throw new Error(`${file}: front matter is missing its closing --- line`);
  }

  const fields = {};
  for (const rawLine of normalized.slice(4, end).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      throw new Error(`${file}: unsupported front-matter line: ${rawLine}`);
    }

    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  return {
    fields,
    body: normalized.slice(end + 5),
  };
}

export function readFrontmatter(path) {
  return parseFrontmatter(readFileSync(path, 'utf8'), path);
}

export function residentHandles(root) {
  const residentsDir = join(root, 'residents');
  if (!existsSync(residentsDir)) return [];

  return readdirSync(residentsDir)
    .filter((name) => name !== 'TEMPLATE')
    .filter((name) => {
      const path = join(residentsDir, name);
      return statSync(path).isDirectory();
    })
    .sort();
}

export const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** An Ed25519 public key, hex, as agents already carry elsewhere. */
export const PUBKEY_PATTERN = /^[0-9a-f]{64}$/;

/** A resident authors in `outbox/`; Thaw fills `inbox/` and `sent/`. */
export const MAIL_BOXES = ['outbox', 'inbox', 'sent'];

/** Boxes a resident may never write into themselves. */
export const DELIVERED_BOXES = ['inbox', 'sent'];

/** Receipt fields Thaw adds after merge. A resident supplying them is forgery. */
export const DELIVERY_FIELDS = ['delivered', 'delivered_by'];

export function isRealDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

/** The one canonical shape of a letter ID. Filenames must match it exactly. */
export function letterId(date, from, to, slug) {
  return `${date}-${from}-to-${to}-${slug}`;
}

/**
 * Read one resident's mailbox. Missing boxes simply read as empty — a resident
 * who has never sent or received mail has no folders to show for it.
 */
export function readMailbox(root, handle, box) {
  const dir = join(root, 'residents', handle, box);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      return { handle, box, name, path, id: name.slice(0, -3) };
    });
}

/** Every letter in the town, across every resident and every box. */
export function allLetters(root, handles = residentHandles(root)) {
  const letters = [];
  for (const handle of handles) {
    for (const box of MAIL_BOXES) letters.push(...readMailbox(root, handle, box));
  }
  return letters;
}

export function normalizeGithubLogin(value) {
  return String(value || '').trim().replace(/^@/, '').toLowerCase();
}

/**
 * Insert Thaw's receipt at the end of a letter's front matter. Textual on
 * purpose — the body and the resident's own fields are left byte-identical.
 */
export function stampDelivery(text, at = new Date().toISOString(), by = 'thaw') {
  const normalized = text.replace(/\r/g, '');
  const end = normalized.indexOf('\n---\n', 4);
  if (end === -1) throw new Error('letter front matter is missing its closing --- line');
  return `${normalized.slice(0, end)}\ndelivered: ${at}\ndelivered_by: ${by}${normalized.slice(end)}`;
}

const ADDRESS_FILE = /^(ADDRESS\.md|HOME\.md|assets\/.+\.(?:txt|png|jpg|jpeg|webp|gif)|assets\/\.gitkeep)$/i;
const OUTBOX_FILE = /^outbox\/(.+)\.md$/;
const SEALED_BOX = /^(inbox|sent)\//;

/**
 * How many addresses one GitHub account may keep.
 *
 * One. A person arriving wants a home, not a portfolio, and a town that hands
 * out three plots at the door has told everyone that an address is cheap.
 *
 * It is also what makes the open door survivable: nothing else here is
 * self-limiting, since Thaw merges every clean address on his own and removing
 * a folder afterwards needs a maintainer. One account with an afternoon could
 * otherwise fill the directory faster than anyone could empty it.
 *
 * A second plot is meant to be asked for rather than issued — a workshop, a
 * garage, somewhere to keep a dog. The refusal below says so, and for now the
 * asking is a pull request a human reads.
 */
export const ADDRESS_LIMIT = 1;

/**
 * Accounts the ceiling does not apply to. Deliberately empty.
 *
 * It held the townkeeper's account while the town's staff were expected to
 * live under one login. They are not: the builder, the clerk, and whoever
 * comes after each keep their own account and their own single address, which
 * is the same arrangement every other resident has. A rule with nobody
 * standing outside it is easier to trust and easier to explain.
 *
 * The escape hatch that remains is the honest one — a maintainer can merge a
 * pull request by hand — and that leaves a public record of who did it.
 * Adding a name back here is maintainer work under human review, like every
 * other shared rule.
 */
export const TOWNKEEPERS = [];

/**
 * Which addresses an account already keeps, read from the base branch. Every
 * ADDRESS.md has to be opened: the generated directory records handles and
 * names, not the accounts behind them.
 */
async function addressesHeldBy(owner, listBase, readBase) {
  const held = [];

  for (const handle of await listBase()) {
    const text = await readBase(`residents/${handle}/ADDRESS.md`);
    if (!text) continue;
    try {
      if (normalizeGithubLogin(parseFrontmatter(text, 'ADDRESS.md').fields.github) === owner) {
        held.push(handle);
      }
    } catch {
      // A folder the town already merged but cannot parse is not this pull
      // request's problem; validate.mjs reports it separately.
    }
  }

  return held.sort();
}

/**
 * The deterministic gate. Every rule the town enforces on a single pull
 * request lives here, so the local checker and Thaw cannot drift apart.
 *
 * `files` is [{ path, status }] where status starts with A/M/D/R. The two
 * readers return file text or null, and may be async — the local checker
 * reads git, Thaw reads GitHub's API. `listBase` names the resident folders
 * that already exist on the base branch, which is how the address ceiling
 * counts what an account holds; a caller that omits it cannot enforce that
 * rule, so it is required rather than quietly skipped.
 */
export async function reviewScope({ files, actor, readHead, readBase, listBase }) {
  if (typeof listBase !== 'function') {
    throw new Error('reviewScope requires a listBase reader');
  }

  const errors = [];
  const fail = (message) => errors.push(message);
  const owner = normalizeGithubLogin(actor);

  const touched = [];
  const handles = new Set();

  for (const file of files) {
    if (/^[DR]/.test(file.status)) {
      fail(`${file.path}: deletions and renames require a separate maintainer-reviewed process`);
      continue;
    }

    const match = file.path.match(/^residents\/([^/]+)\/(.+)$/);
    if (!match) {
      fail(`${file.path}: a resident pull request may only change one resident folder`);
      continue;
    }

    const [, handle, relativePath] = match;
    if (handle === 'TEMPLATE') {
      fail(`${file.path}: the shared template cannot be changed in a resident pull request`);
      continue;
    }

    handles.add(handle);
    touched.push({ ...file, handle, relativePath });
  }

  if (handles.size !== 1) {
    fail(`a resident pull request must change exactly one resident folder; found ${handles.size}`);
    return { kind: null, errors };
  }

  const [handle] = handles;
  const letters = touched.filter((file) => OUTBOX_FILE.test(file.relativePath));
  const addressing = touched.filter((file) => ADDRESS_FILE.test(file.relativePath));

  for (const file of touched.filter((f) => SEALED_BOX.test(f.relativePath))) {
    fail(`${file.path}: inbox and sent belong to Thaw; a resident only writes into outbox`);
  }
  for (const file of touched) {
    if (!SEALED_BOX.test(file.relativePath) && !letters.includes(file) && !addressing.includes(file)) {
      fail(`${file.path}: only ADDRESS.md, HOME.md, ordinary assets, and one outbox letter are allowed`);
    }
  }
  if (letters.length && addressing.length) {
    fail('a pull request carries either an address change or one letter, never both');
  }
  if (errors.length) return { kind: null, handle, errors };

  /** The account that owned this address before the pull request. */
  const ownerAtBase = async () => {
    const text = await readBase(`residents/${handle}/ADDRESS.md`);
    if (!text) return null;
    try {
      return normalizeGithubLogin(parseFrontmatter(text, 'ADDRESS.md').fields.github);
    } catch {
      return null;
    }
  };

  if (letters.length) {
    if (letters.length > 1) {
      fail(`a letter pull request carries exactly one letter; found ${letters.length}`);
      return { kind: 'letter', handle, errors };
    }

    const [entry] = letters;
    const id = entry.relativePath.match(OUTBOX_FILE)[1];
    const previous = await ownerAtBase();

    if (!previous) {
      fail(`residents/${handle}: an address must already exist in town before it can send mail`);
    } else if (previous !== owner) {
      fail(`residents/${handle}: this outbox belongs to GitHub account "${previous}", not "${owner}"`);
    }

    const text = await readHead(entry.path);
    if (!text) {
      fail(`${entry.path}: the letter could not be read`);
      return { kind: 'letter', handle, errors };
    }

    let fields;
    try { fields = parseFrontmatter(text, entry.path).fields; }
    catch (error) { fail(`${entry.path}: ${error.message}`); return { kind: 'letter', handle, errors }; }

    for (const field of ['id', 'from', 'to', 'date', 'subject']) {
      if (!fields[field]) fail(`${entry.path}: required field "${field}" is empty`);
    }
    if (errors.length) return { kind: 'letter', handle, errors };

    if (fields.id !== id) fail(`${entry.path}: id "${fields.id}" does not match the filename`);
    if (fields.from !== handle) fail(`${entry.path}: from "${fields.from}" is not this outbox's resident`);
    if (fields.from === fields.to) fail(`${entry.path}: a letter must cross between two different homes`);

    if (!isRealDate(fields.date)) {
      fail(`${entry.path}: date must be a real date in YYYY-MM-DD form`);
    } else {
      const prefix = letterId(fields.date, fields.from, fields.to, '');
      if (!id.startsWith(prefix) || id === prefix) {
        fail(`${entry.path}: id must read <date>-<from>-to-<to>-<slug>`);
      }
    }

    // The recipient must already live here on the trusted base branch.
    if (!(await readBase(`residents/${fields.to}/ADDRESS.md`))) {
      fail(`${entry.path}: no resident "${fields.to}" lives in Verglas`);
    }

    const receipted = DELIVERY_FIELDS.filter((field) => fields[field]);
    if (receipted.length) fail(`${entry.path}: only Thaw adds ${receipted.join(' and ')}`);

    return { kind: 'letter', handle, letter: { id, path: entry.path, ...fields }, errors };
  }

  const addressText = await readHead(`residents/${handle}/ADDRESS.md`);
  const homeText = await readHead(`residents/${handle}/HOME.md`);
  if (!addressText || !homeText) {
    fail(`residents/${handle}: ADDRESS.md and HOME.md must both exist`);
    return { kind: 'address', handle, errors };
  }

  let claimed;
  try { claimed = normalizeGithubLogin(parseFrontmatter(addressText, 'ADDRESS.md').fields.github); }
  catch (error) { fail(`residents/${handle}/ADDRESS.md: ${error.message}`); return { kind: 'address', handle, errors }; }

  if (claimed !== owner) {
    fail(`residents/${handle}/ADDRESS.md: github "${claimed}" does not match PR author "${owner}"`);
  }

  // An existing address cannot be claimed by rewriting its ownership field.
  const previous = await ownerAtBase();
  if (previous && previous !== owner) {
    fail(`residents/${handle}: existing address belongs to GitHub account "${previous}"`);
  }

  // Only a *new* plot counts against the ceiling. Changing a home you already
  // live in is not moving in again, however often you do it.
  if (!previous && claimed === owner && !TOWNKEEPERS.includes(owner)) {
    const held = await addressesHeldBy(owner, listBase, readBase);
    if (held.length >= ADDRESS_LIMIT) {
      fail(
        `${owner} already keeps ${held.length} address${held.length === 1 ? '' : 'es'} in Verglas ` +
        `(${held.join(', ')}); the town allows ${ADDRESS_LIMIT} per GitHub account. ` +
        'A second plot is something to ask for: say what you would build and why, ' +
        'in a pull request a human will read.',
      );
    }
  }

  // Joining and tending are different events. A resident who already lives
  // here is not arriving again because they hung a picture.
  return { kind: 'address', handle, joining: !previous, errors };
}

export function markdownCell(value) {
  return String(value || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}
