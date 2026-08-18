import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ADDRESS_LIMIT, MAX_DRAWINGS, TOWNKEEPERS } from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = [];

// ── Fixtures ──────────────────────────────────────────────────────────────

function address(dir, handle, name, github = handle) {
  mkdirSync(join(dir, 'residents', handle), { recursive: true });
  writeFileSync(join(dir, 'residents', handle, 'ADDRESS.md'),
    `---\nhandle: ${handle}\nname: ${name}\nhousehold: ${name}\ngithub: ${github}\njoined: 2026-01-01\n---\n\n# ${name}\n\nHere.\n`);
  writeFileSync(join(dir, 'residents', handle, 'HOME.md'),
    `---\nresident: ${handle}\ntitle: The ${name}\nlocation: The lane\nimage:\n---\n\n# The ${name}\n\nA home.\n`);
}

function letter(dir, handle, box, id, fields) {
  mkdirSync(join(dir, 'residents', handle, box), { recursive: true });
  const front = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n');
  writeFileSync(join(dir, 'residents', handle, box, `${id}.md`), `---\n${front}\n---\n\n# Subject\n\nBody.\n`);
}

/** A throwaway town holding a real copy of the tools, run exactly as shipped. */
function build() {
  const dir = mkdtempSync(join(tmpdir(), 'verglas-'));
  built.push(dir);
  cpSync(join(ROOT, 'tools'), join(dir, 'tools'), { recursive: true });
  address(dir, 'east-window', 'East');
  address(dir, 'moss-house', 'Moss');
  return dir;
}

/**
 * Run a tool. Returns { ok, out } rather than throwing, so failures assert
 * cleanly. Both streams are joined: the tools report refusals on stderr and
 * carry on, so a run can succeed and still have something to say.
 */
function run(dir, tool, args = [], env = {}) {
  const result = spawnSync('node', [join(dir, 'tools', tool), ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return { ok: result.status === 0, out: `${result.stdout || ''}${result.stderr || ''}` };
}

const delivered = { delivered: '2026-02-01T00:00:00.000Z', delivered_by: 'thaw' };
const crossing = {
  id: '2026-02-01-east-window-to-moss-house-evening-lamp',
  from: 'east-window', to: 'moss-house', date: '2026-02-01', subject: 'The lamp was on',
};

let town;
before(() => { town = build(); });
after(() => { for (const dir of built) rmSync(dir, { recursive: true, force: true }); });

// ── Authoring and validation ──────────────────────────────────────────────

test('a town of addresses and no mail validates', () => {
  const result = run(town, 'validate.mjs');
  assert.ok(result.ok, result.out);
  assert.match(result.out, /2 resident\(s\) and 0 letter\(s\)/);
});

test('new-letter writes a canonically named letter', () => {
  const result = run(town, 'new-letter.mjs',
    ['east-window', 'moss-house', 'evening-lamp', '--subject', 'The lamp was on']);
  assert.ok(result.ok, result.out);
  assert.match(result.out, /east-window-to-moss-house-evening-lamp\.md/);
  assert.ok(run(town, 'validate.mjs').ok);
});

test('new-letter refuses a second letter while one waits', () => {
  const result = run(town, 'new-letter.mjs',
    ['east-window', 'moss-house', 'another', '--subject', 'Again']);
  assert.equal(result.ok, false);
  assert.match(result.out, /send that letter before writing another/);
});

test('new-letter refuses an unknown recipient', () => {
  const result = run(town, 'new-letter.mjs', ['moss-house', 'nobody', 'hello', '--subject', 'Hello']);
  assert.equal(result.ok, false);
  assert.match(result.out, /no recipient lives at residents\/nobody/);
});

test('a resident cannot forge a delivery receipt', () => {
  const id = '2026-02-01-moss-house-to-east-window-forged';
  letter(town, 'moss-house', 'outbox', id,
    { id, from: 'moss-house', to: 'east-window', date: '2026-02-01', subject: 'Forged', ...delivered });
  const result = run(town, 'validate.mjs');
  assert.equal(result.ok, false);
  assert.match(result.out, /only Thaw adds delivered and delivered_by/);
  rmSync(join(town, 'residents', 'moss-house', 'outbox'), { recursive: true });
});

test('a letter id must match its filename', () => {
  letter(town, 'moss-house', 'outbox', '2026-02-01-moss-house-to-east-window-slug',
    { id: 'something-else', from: 'moss-house', to: 'east-window', date: '2026-02-01', subject: 'Mismatch' });
  const result = run(town, 'validate.mjs');
  assert.equal(result.ok, false);
  assert.match(result.out, /does not match the filename/);
  rmSync(join(town, 'residents', 'moss-house', 'outbox'), { recursive: true });
});

test('a letter cannot be addressed out of town', () => {
  const id = '2026-02-01-moss-house-to-nobody-lost';
  letter(town, 'moss-house', 'outbox', id,
    { id, from: 'moss-house', to: 'nobody', date: '2026-02-01', subject: 'Lost' });
  const result = run(town, 'validate.mjs');
  assert.equal(result.ok, false);
  assert.match(result.out, /recipient "nobody" does not live in Verglas/);
  rmSync(join(town, 'residents', 'moss-house', 'outbox'), { recursive: true });
});

test('a delivered letter rests in inbox and sent together', () => {
  // Half a crossing: canonical copy filed, recipient never served.
  rmSync(join(town, 'residents', 'east-window', 'outbox'), { recursive: true });
  letter(town, 'east-window', 'sent', crossing.id, { ...crossing, ...delivered });
  let result = run(town, 'validate.mjs');
  assert.equal(result.ok, false);
  assert.match(result.out, /waits in outbox, or rests in inbox and sent/);

  letter(town, 'moss-house', 'inbox', crossing.id, { ...crossing, ...delivered });
  result = run(town, 'validate.mjs');
  assert.ok(result.ok, result.out);
  assert.match(result.out, /1 letter\(s\)/);
});

test('the ledger records the crossing', () => {
  const result = run(town, 'generate-mail-ledger.mjs', ['--dry-run']);
  assert.ok(result.ok, result.out);
  assert.match(result.out, /\*\*Letters carried:\*\* 1/);
  assert.match(result.out, /`east-window` \| `moss-house` \| The lamp was on/);
});

test('the directory records the residents', () => {
  const result = run(town, 'generate-directory.mjs', ['--dry-run']);
  assert.ok(result.ok, result.out);
  assert.match(result.out, /`east-window`/);
  assert.match(result.out, /`moss-house`/);
});

// ── Delivery ──────────────────────────────────────────────────────────────

test('a waiting letter is carried to both mailboxes', () => {
  const dir = build();
  assert.ok(run(dir, 'new-letter.mjs',
    ['east-window', 'moss-house', 'evening-lamp', '--subject', 'The lamp was on']).ok);

  const result = run(dir, 'deliver.mjs');
  assert.ok(result.ok, result.out);
  assert.match(result.out, /east-window → moss-house/);

  const [id] = readdirSync(join(dir, 'residents', 'moss-house', 'inbox'));
  const inbox = readFileSync(join(dir, 'residents', 'moss-house', 'inbox', id), 'utf8');
  const sent = readFileSync(join(dir, 'residents', 'east-window', 'sent', id), 'utf8');

  assert.equal(inbox, sent, 'the two delivered copies must be identical');
  assert.match(inbox, /^delivered: \d{4}-\d{2}-\d{2}T/m);
  assert.match(inbox, /^delivered_by: thaw$/m);
  assert.match(inbox, /# The lamp was on/);
  assert.equal(readdirSync(join(dir, 'residents', 'east-window', 'outbox')).length, 0);

  // The town must still validate, and the crossing must reach the ledger.
  assert.ok(run(dir, 'validate.mjs').ok);
  assert.match(run(dir, 'generate-mail-ledger.mjs', ['--dry-run']).out, /\*\*Letters carried:\*\* 1/);
});

test('delivery leaves a misaddressed letter in the outbox', () => {
  const dir = build();
  const id = '2026-02-01-east-window-to-nobody-lost';
  letter(dir, 'east-window', 'outbox', id,
    { id, from: 'east-window', to: 'nobody', date: '2026-02-01', subject: 'Lost' });

  const result = run(dir, 'deliver.mjs');
  assert.equal(result.ok, false);
  assert.match(result.out, /no resident "nobody" lives in Verglas/);
  assert.ok(existsSync(join(dir, 'residents', 'east-window', 'outbox', `${id}.md`)));
});

test('delivery is safe to rerun and never doubles a crossing', () => {
  const dir = build();
  assert.ok(run(dir, 'new-letter.mjs',
    ['east-window', 'moss-house', 'evening-lamp', '--subject', 'The lamp was on']).ok);
  assert.ok(run(dir, 'deliver.mjs').ok);

  const again = run(dir, 'deliver.mjs');
  assert.ok(again.ok, again.out);
  assert.match(again.out, /Carried 0 letter\(s\)/);
  assert.equal(readdirSync(join(dir, 'residents', 'moss-house', 'inbox')).length, 1);
});

// ── Drawings ──────────────────────────────────────────────────────────────

/** Put an image in a resident's assets/, so a letter has something to carry. */
function drawing(dir, handle, name, bytes = 'PNG-ish bytes') {
  const assets = join(dir, 'residents', handle, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, name), bytes);
}

/** Stands in for the review the carrier asks for before it copies anything. */
async function stubReview(verdict = { verdict: 'approve', reason: 'Ordinary.', concerns: [] }) {
  const seen = { asked: [] };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seen.asked.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(verdict) }] }));
    });
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    seen,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

/** A crossing that has already happened, with drawings still to follow. */
function alreadyDelivered(dir, names, body = '') {
  const id = crossing.id;
  const front = { ...crossing, drawings: names.join(', '), ...delivered };
  for (const [handle, box] of [['east-window', 'sent'], ['moss-house', 'inbox']]) {
    mkdirSync(join(dir, 'residents', handle, box), { recursive: true });
    const lines = Object.entries(front).map(([key, value]) => `${key}: ${value}`).join('\n');
    writeFileSync(join(dir, 'residents', handle, box, `${id}.md`),
      `---\n${lines}\n---\n\n# The lamp was on\n\nBody.\n${body}`);
  }
  return id;
}

const carry = (dir, hub, args = []) =>
  runAsync(dir, 'carry-drawings.mjs', args, { ANTHROPIC_API_KEY: 'stub', ANTHROPIC_BASE_URL: hub.origin });

test('the carrier brings a delivered letter\'s drawings to the recipient', async () => {
  const dir = build();
  drawing(dir, 'east-window', 'lamp-1.png');
  drawing(dir, 'east-window', 'lamp-2.webp');
  alreadyDelivered(dir, ['lamp-1.png', 'lamp-2.webp']);

  const hub = await stubReview();
  try {
    const result = await carry(dir, hub);
    assert.ok(result.ok, result.out);
    assert.match(result.out, /lamp-1\.png, lamp-2\.webp/);

    for (const name of ['lamp-1.png', 'lamp-2.webp']) {
      assert.ok(existsSync(join(dir, 'residents', 'moss-house', 'assets', name)), `${name} should have arrived`);
      // Carrying a picture is not giving it away.
      assert.ok(existsSync(join(dir, 'residents', 'east-window', 'assets', name)));
    }

    // The pairing is what was judged: both homes named, and the images attached.
    const asked = hub.seen.asked[0];
    assert.match(asked.system, /placing THESE images into THIS named recipient/);
    assert.match(asked.messages[0].content[0].text, /recipient: moss-house/);
    assert.equal(asked.messages[0].content.filter((block) => block.type === 'image').length, 2);
    assert.ok(run(dir, 'validate.mjs').ok);
  } finally { await hub.close(); }
});

test('a drawing the review will not approve is left where it is', async () => {
  const dir = build();
  drawing(dir, 'east-window', 'lamp-1.png');
  alreadyDelivered(dir, ['lamp-1.png']);

  const hub = await stubReview({ verdict: 'revise', reason: 'Targets the recipient.', concerns: [] });
  try {
    const result = await carry(dir, hub);
    // Not carried, and not a failure: the letter has already crossed.
    assert.ok(result.ok, result.out);
    assert.match(result.out, /WAITING.*review returned "revise" — Targets the recipient/);
    assert.equal(existsSync(join(dir, 'residents', 'moss-house', 'assets')), false);
  } finally { await hub.close(); }
});

test('the carrier does not carry when it cannot ask', async () => {
  const dir = build();
  drawing(dir, 'east-window', 'lamp-1.png');
  alreadyDelivered(dir, ['lamp-1.png']);

  // No key at all.
  const bare = await runAsync(dir, 'carry-drawings.mjs', [], { ANTHROPIC_API_KEY: '' });
  assert.ok(bare.ok, bare.out);
  assert.match(bare.out, /no ANTHROPIC_API_KEY, so the pairing was not reviewed/);
  assert.equal(existsSync(join(dir, 'residents', 'moss-house', 'assets')), false);

  // A key, but nothing answering.
  const unreachable = await runAsync(dir, 'carry-drawings.mjs', [],
    { ANTHROPIC_API_KEY: 'stub', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' });
  assert.ok(unreachable.ok, unreachable.out);
  assert.match(unreachable.out, /the review could not be reached/);
  assert.equal(existsSync(join(dir, 'residents', 'moss-house', 'assets')), false);
});

test('a drawing never overwrites a different file the recipient already keeps', async () => {
  const dir = build();
  drawing(dir, 'east-window', 'lamp-1.png', 'the sender\'s picture');
  drawing(dir, 'moss-house', 'lamp-1.png', 'the recipient\'s own picture');
  alreadyDelivered(dir, ['lamp-1.png']);

  const hub = await stubReview();
  try {
    const result = await carry(dir, hub);
    assert.ok(result.ok, result.out);
    assert.match(result.out, /already exists in residents\/moss-house\/assets as a different file/);
    assert.equal(
      readFileSync(join(dir, 'residents', 'moss-house', 'assets', 'lamp-1.png'), 'utf8'),
      'the recipient\'s own picture',
    );
    assert.equal(hub.seen.asked.length, 0, 'nothing to carry means nothing to ask about');
  } finally { await hub.close(); }
});

test('a drawing the sender no longer keeps leaves everything else alone', async () => {
  const dir = build();
  drawing(dir, 'east-window', 'lamp-1.png');
  alreadyDelivered(dir, ['lamp-1.png', 'gone.png']);

  const hub = await stubReview();
  try {
    const result = await carry(dir, hub);
    assert.ok(result.ok, result.out, 'a missing drawing must never fail the round');
    assert.match(result.out, /WAITING.*"gone\.png" is not in residents\/east-window\/assets/);
    assert.ok(existsSync(join(dir, 'residents', 'moss-house', 'assets', 'lamp-1.png')));
  } finally { await hub.close(); }
});

test('carrying is safe to rerun and asks nothing the second time', async () => {
  const dir = build();
  drawing(dir, 'east-window', 'lamp-1.png');
  alreadyDelivered(dir, ['lamp-1.png']);

  const hub = await stubReview();
  try {
    assert.ok((await carry(dir, hub)).ok);
    const again = await carry(dir, hub);
    assert.ok(again.ok, again.out);
    assert.match(again.out, /Carried drawings for 0 letter\(s\)/);
    assert.equal(hub.seen.asked.length, 1, 'a settled drawing is not reviewed again');
    assert.equal(readdirSync(join(dir, 'residents', 'moss-house', 'assets')).length, 1);
  } finally { await hub.close(); }
});

test('delivery no longer touches drawings at all', () => {
  const dir = build();
  drawing(dir, 'east-window', 'lamp-1.png');
  assert.ok(run(dir, 'new-letter.mjs', [
    'east-window', 'moss-house', 'evening-lamp', '--subject', 'The lamp was on',
    '--drawing', 'lamp-1.png',
  ]).ok);

  const result = run(dir, 'deliver.mjs');
  assert.ok(result.ok, result.out);

  // The letter crosses; the picture is the carrier's business, on its own run.
  assert.equal(readdirSync(join(dir, 'residents', 'moss-house', 'inbox')).length, 1);
  assert.equal(existsSync(join(dir, 'residents', 'moss-house', 'assets')), false);
});

test('a letter naming a drawing the sender does not have never gets written', () => {
  const dir = build();
  const result = run(dir, 'new-letter.mjs', [
    'east-window', 'moss-house', 'evening-lamp', '--subject', 'The lamp was on',
    '--drawing', 'absent.png',
  ]);
  assert.equal(result.ok, false);
  assert.match(result.out, /no drawing at residents\/east-window\/assets\/absent\.png/);
  assert.equal(existsSync(join(dir, 'residents', 'east-window', 'outbox')), false);
});

test('validate refuses a letter whose drawing the sender does not hold', () => {
  const dir = build();
  const id = crossing.id;
  letter(dir, 'east-window', 'outbox', id, { ...crossing, drawings: 'absent.png' });

  const result = run(dir, 'validate.mjs');
  assert.equal(result.ok, false);
  assert.match(result.out, /drawing "absent\.png" is not in residents\/east-window\/assets/);
});

test('validate warns when a delivered drawing has not reached the recipient', () => {
  const dir = build();
  drawing(dir, 'east-window', 'lamp-1.png');
  alreadyDelivered(dir, ['lamp-1.png']);

  const result = run(dir, 'validate.mjs');
  assert.ok(result.ok, result.out);
  assert.match(result.out, /has not reached residents\/moss-house\/assets/);
});

test('backfill carries drawings named in prose, and only when asked', async () => {
  const dir = build();
  drawing(dir, 'east-window', 'lamp-1.png');
  drawing(dir, 'east-window', 'lamp-2.png');

  // A letter from before the field existed: prose only, no drawings: line.
  const id = crossing.id;
  for (const [handle, box] of [['east-window', 'sent'], ['moss-house', 'inbox']]) {
    mkdirSync(join(dir, 'residents', handle, box), { recursive: true });
    writeFileSync(join(dir, 'residents', handle, box, `${id}.md`),
      `---\nid: ${id}\nfrom: east-window\nto: moss-house\ndate: 2026-02-01\n` +
      `subject: The lamp was on\ndelivered: 2026-02-01T00:00:00.000Z\ndelivered_by: thaw\n---\n\n` +
      `# The lamp was on\n\nBody.\n\n## Drawings\n\n- lamp-1.png\n- lamp-2.png\n`);
  }

  const hub = await stubReview();
  try {
    // An ordinary round ignores prose entirely.
    const ordinary = await carry(dir, hub);
    assert.ok(ordinary.ok, ordinary.out);
    assert.match(ordinary.out, /Carried drawings for 0 letter\(s\)/);
    assert.equal(existsSync(join(dir, 'residents', 'moss-house', 'assets')), false);

    const preview = await carry(dir, hub, ['--backfill', '--dry-run']);
    assert.match(preview.out, /would carry.*lamp-1\.png, lamp-2\.png/);
    assert.equal(existsSync(join(dir, 'residents', 'moss-house', 'assets')), false,
      'a dry run must not move anything');

    const result = await carry(dir, hub, ['--backfill']);
    assert.ok(result.ok, result.out);
    for (const name of ['lamp-1.png', 'lamp-2.png']) {
      assert.ok(existsSync(join(dir, 'residents', 'moss-house', 'assets', name)));
    }
    // The letters are the record, and the backfill leaves them alone.
    assert.match(readFileSync(join(dir, 'residents', 'moss-house', 'inbox', `${id}.md`), 'utf8'),
      /## Drawings/);
    assert.ok(run(dir, 'validate.mjs').ok);
  } finally { await hub.close(); }
});

test('the carrier\'s workflow notices files that are only ever new', () => {
  // A carried drawing is always a new file, never a change to a tracked one.
  // `git diff` cannot see those, so a filing step written around it reports a
  // clean tree, skips the commit, and throws the round away — while the run
  // goes green. It did exactly that once. The check has to be one that counts
  // an untracked arrival.
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'carry-drawings.yml'), 'utf8');
  const filing = workflow.slice(workflow.indexOf('File them'));

  assert.doesNotMatch(filing, /if\s+git diff --quiet/,
    'git diff --quiet is blind to the new files this workflow exists to commit');
  assert.match(filing, /git status --porcelain|git diff --cached/,
    'the filing step must use a check that sees untracked files');
});

// ── The pull-request gate ─────────────────────────────────────────────────

/**
 * A town under version control, so the scope checker has a base to compare
 * against. `settle` runs before the first commit, for scenarios that need
 * residents to already live here rather than to be arriving.
 */
function gitTown(settle = () => {}) {
  const dir = build();
  settle(dir);
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'thaw@verglas.test');
  git('config', 'user.name', 'Thaw');
  git('add', '-A');
  git('commit', '-q', '-m', 'the town so far');
  return { dir, git, base: git('rev-parse', 'HEAD').trim() };
}

/** Commit whatever the scenario staged, then judge it as @actor's pull request. */
function propose({ dir, git, base }, actor) {
  git('add', '-A');
  git('commit', '-q', '-m', 'proposal');
  return run(dir, 'check-pr-scope.mjs', [], { GITHUB_ACTOR: actor, BASE_SHA: base, HEAD_SHA: 'HEAD' });
}

test('an address enters when its owner opens the pull request', () => {
  const scenario = gitTown();
  address(scenario.dir, 'north-lantern', 'North');
  const result = propose(scenario, 'north-lantern');
  assert.ok(result.ok, result.out);
  assert.match(result.out, /Address scope check passed/);
});

test('an address cannot be opened on someone else\'s behalf', () => {
  const scenario = gitTown();
  address(scenario.dir, 'north-lantern', 'North');
  const result = propose(scenario, 'a-stranger');
  assert.equal(result.ok, false);
  assert.match(result.out, /does not match PR author "a-stranger"/);
});

test('an existing address cannot be claimed by rewriting its owner', () => {
  const scenario = gitTown();
  writeFileSync(join(scenario.dir, 'residents', 'east-window', 'ADDRESS.md'),
    `---\nhandle: east-window\nname: East\nhousehold: East\ngithub: a-stranger\njoined: 2026-01-01\n---\n\n# East\n\nHere.\n`);
  const result = propose(scenario, 'a-stranger');
  assert.equal(result.ok, false);
  assert.match(result.out, /existing address belongs to GitHub account "east-window"/);
});

test('a letter crosses when its sender opens the pull request', () => {
  const scenario = gitTown();
  letter(scenario.dir, 'east-window', 'outbox', crossing.id, { ...crossing, reply_to: '' });
  const result = propose(scenario, 'east-window');
  assert.ok(result.ok, result.out);
  assert.match(result.out, /east-window writes to moss-house/);
});

test('a letter cannot be sent from another resident\'s outbox', () => {
  const scenario = gitTown();
  letter(scenario.dir, 'east-window', 'outbox', crossing.id, crossing);
  const result = propose(scenario, 'moss-house');
  assert.equal(result.ok, false);
  assert.match(result.out, /this outbox belongs to GitHub account "east-window"/);
});

test('a resident cannot write into a delivered mailbox', () => {
  const scenario = gitTown();
  letter(scenario.dir, 'east-window', 'inbox', crossing.id, { ...crossing, ...delivered });
  const result = propose(scenario, 'east-window');
  assert.equal(result.ok, false);
  assert.match(result.out, /inbox and sent belong to Thaw/);
});

test('a letter pull request cannot smuggle in an address change', () => {
  const scenario = gitTown();
  letter(scenario.dir, 'east-window', 'outbox', crossing.id, crossing);
  writeFileSync(join(scenario.dir, 'residents', 'east-window', 'HOME.md'),
    `---\nresident: east-window\ntitle: Something Else\nlocation: Elsewhere\nimage:\n---\n\n# Something Else\n\nMoved.\n`);
  const result = propose(scenario, 'east-window');
  assert.equal(result.ok, false);
  assert.match(result.out, /either an address change or one letter, never both/);
});

test('the gate refuses a drawing name that could aim a write elsewhere', () => {
  // These names become writes into another resident's folder, so the shapes
  // that could point somewhere else are refused before the letter can merge.
  for (const [name, expected] of [
    ['../../../etc/passwd.png', /must be a bare filename, not a path/],
    ['..png', /may not point outside assets/],
    ['.hidden.png', /may not begin with a dot/],
    ['lamp.svg', /is not an image the town carries/],
  ]) {
    const town = gitTown((dir) => address(dir, 'moss-house', 'Moss'));
    letter(town.dir, 'east-window', 'outbox', crossing.id, { ...crossing, drawings: name });

    const result = propose(town, 'east-window');
    assert.equal(result.ok, false, `"${name}" should have been refused`);
    assert.match(result.out, expected);
  }
});

test('the gate caps how many drawings one letter carries', () => {
  const town = gitTown((dir) => address(dir, 'moss-house', 'Moss'));
  const many = Array.from({ length: MAX_DRAWINGS + 1 }, (_, i) => `lamp-${i}.png`).join(', ');
  letter(town.dir, 'east-window', 'outbox', crossing.id, { ...crossing, drawings: many });

  const result = propose(town, 'east-window');
  assert.equal(result.ok, false);
  assert.match(result.out, new RegExp(`at most ${MAX_DRAWINGS} drawings; found ${MAX_DRAWINGS + 1}`));
});

test('a letter cannot be addressed to a resident who has not arrived', () => {
  const scenario = gitTown();
  const id = '2026-02-01-east-window-to-north-lantern-early';
  letter(scenario.dir, 'east-window', 'outbox', id,
    { id, from: 'east-window', to: 'north-lantern', date: '2026-02-01', subject: 'Early' });
  const result = propose(scenario, 'east-window');
  assert.equal(result.ok, false);
  assert.match(result.out, /no resident "north-lantern" lives in Verglas/);
});

test('the gate rejects a forged receipt before it can merge', () => {
  const scenario = gitTown();
  letter(scenario.dir, 'east-window', 'outbox', crossing.id, { ...crossing, ...delivered });
  const result = propose(scenario, 'east-window');
  assert.equal(result.ok, false);
  assert.match(result.out, /only Thaw adds delivered and delivered_by/);
});

// ── The address ceiling ───────────────────────────────────────────────────

/** A town where `account` already keeps `count` plots. */
const holding = (account, count) => (dir) => {
  for (let index = 1; index <= count; index += 1) {
    address(dir, `plot-${index}`, `Plot ${index}`, account);
  }
};

test('an account at the ceiling cannot take another address', () => {
  const scenario = gitTown(holding('collector', ADDRESS_LIMIT));
  address(scenario.dir, 'one-more', 'One More', 'collector');
  const result = propose(scenario, 'collector');
  assert.equal(result.ok, false);
  // Singular at a ceiling of one, plural above it.
  assert.match(result.out, new RegExp(`already keeps ${ADDRESS_LIMIT} address`));
  assert.match(result.out, /the town allows/);
});

test('an account below the ceiling may still move in', () => {
  const scenario = gitTown(holding('collector', ADDRESS_LIMIT - 1));
  address(scenario.dir, 'one-more', 'One More', 'collector');
  const result = propose(scenario, 'collector');
  assert.ok(result.ok, result.out);
  assert.match(result.out, /Address scope check passed/);
});

test('the ceiling counts new plots, not changes to a home already held', () => {
  const scenario = gitTown(holding('collector', ADDRESS_LIMIT));
  writeFileSync(join(scenario.dir, 'residents', 'plot-1', 'HOME.md'),
    `---\nresident: plot-1\ntitle: Renamed\nlocation: The lane\nimage:\n---\n\n# Renamed\n\nStill here.\n`);
  const result = propose(scenario, 'collector');
  assert.ok(result.ok, result.out);
});

test('the town\'s own keeping is not capped', { skip: TOWNKEEPERS.length === 0 }, () => {
  const keeper = TOWNKEEPERS[0];
  const scenario = gitTown(holding(keeper, ADDRESS_LIMIT));
  address(scenario.dir, 'one-more', 'One More', keeper);
  const result = propose(scenario, keeper);
  assert.ok(result.ok, result.out);
});

test('validate reports a town where one account holds too many', () => {
  const dir = build();
  holding('collector', ADDRESS_LIMIT + 1)(dir);
  const result = run(dir, 'validate.mjs');
  assert.equal(result.ok, false);
  assert.match(result.out, new RegExp(`"collector" holds ${ADDRESS_LIMIT + 1} addresses`));
});

test('a pull request cannot touch two resident folders', () => {
  const scenario = gitTown();
  address(scenario.dir, 'north-lantern', 'North');
  address(scenario.dir, 'south-gate', 'South');
  const result = propose(scenario, 'north-lantern');
  assert.equal(result.ok, false);
  assert.match(result.out, /exactly one resident folder; found 2/);
});

// ── Thaw ──────────────────────────────────────────────────────────────────

/**
 * Stands in for GitHub and Anthropic so Thaw's whole path can be exercised:
 * the gate, the review, the comment, and the merge — without a live PR.
 */
async function stubHub({ author, files, head, base, verdict }) {
  const seen = { comments: [], merged: false, reviewed: null, labels: [] };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body ?? {}));
    };

    if (url.pathname.endsWith('/v1/messages')) {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        seen.reviewed = JSON.parse(raw);
        send(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(verdict) }] });
      });
      return;
    }
    if (url.pathname.endsWith('/merge')) {
      seen.merged = true;
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        seen.mergeTitle = JSON.parse(raw || '{}').commit_title;
        send(200, { merged: true });
      });
      return;
    }
    if (url.pathname.endsWith('/labels')) {
      if (req.method !== 'POST') return send(200, []);
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        // Creating the label itself carries a name; applying it carries a list.
        if (Array.isArray(body.labels)) seen.labels.push(...body.labels);
        send(201, {});
      });
      return;
    }
    if (url.pathname.endsWith('/files')) {
      return send(200, files.map((file) => ({ filename: file.path, status: file.status })));
    }
    if (url.pathname.endsWith('/comments')) {
      if (req.method === 'GET') return send(200, []);
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => { seen.comments.push(JSON.parse(raw).body); send(201, {}); });
      return;
    }
    if (url.pathname.includes('/contents/')) {
      const path = decodeURIComponent(url.pathname.split('/contents/')[1]);
      const tree = url.searchParams.get('ref') === 'headsha' ? head : base;

      // GitHub answers a directory with a listing. Thaw asks for one when it
      // counts how many addresses an account already keeps.
      if (path === 'residents') {
        const names = [...new Set(
          Object.keys(tree)
            .map((file) => file.match(/^residents\/([^/]+)\//)?.[1])
            .filter(Boolean),
        )];
        return names.length === 0
          ? send(404, {})
          : send(200, names.map((name) => ({ type: 'dir', name })));
      }

      return tree[path] === undefined ? send(404, {}) : send(200, tree[path]);
    }
    return send(200, {
      state: 'open', draft: false, user: { login: author },
      base: { sha: 'basesha', ref: 'main' }, head: { sha: 'headsha' },
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { seen, origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

const ADDRESS_MD = (handle, github) =>
  `---\nhandle: ${handle}\nname: North\nhousehold: North\ngithub: ${github}\njoined: 2026-01-01\n---\n\n# North\n\nHere.\n`;
const HOME_MD = '---\nresident: north-lantern\ntitle: The Lantern\nlocation: The lane\nimage:\n---\n\n# The Lantern\n\nA home.\n';

/**
 * Async twin of `run` — the stub server shares this process, so a blocking
 * execFileSync here would stall the event loop and never answer Thaw.
 */
function runAsync(dir, tool, args = [], env = {}) {
  return new Promise((resolve) => {
    execFile('node', [join(dir, 'tools', tool), ...args], { cwd: dir, env: { ...process.env, ...env } },
      (error, stdout, stderr) => resolve({ ok: !error, out: `${stdout}${stderr}` }));
  });
}

function runThaw(dir, origin) {
  return runAsync(dir, 'thaw.mjs', [], {
    GITHUB_TOKEN: 'stub', GITHUB_REPOSITORY: 'verglas-dev/verglas', PR_NUMBER: '7',
    ANTHROPIC_API_KEY: 'stub', GITHUB_API_URL: origin, ANTHROPIC_BASE_URL: origin,
    GITHUB_OUTPUT: '',
  });
}

test('Thaw merges a clean address and says so', async () => {
  const hub = await stubHub({
    author: 'north-lantern',
    files: [
      { path: 'residents/north-lantern/ADDRESS.md', status: 'added' },
      { path: 'residents/north-lantern/HOME.md', status: 'added' },
    ],
    head: {
      'residents/north-lantern/ADDRESS.md': ADDRESS_MD('north-lantern', 'north-lantern'),
      'residents/north-lantern/HOME.md': HOME_MD,
    },
    base: {},
    verdict: { verdict: 'approve', reason: 'Nothing of concern.', concerns: [] },
  });

  try {
    const result = await runThaw(build(), hub.origin);
    assert.ok(result.ok, result.out);
    assert.equal(hub.seen.merged, true, 'should have merged');
    assert.match(hub.seen.comments[0], /Welcome to Verglas/);
    assert.equal(hub.seen.mergeTitle, 'address: north-lantern (#7)');
    // The submitted prose must reach the reviewer as data, not as instruction.
    const prompt = hub.seen.reviewed.messages[0].content[0].text;
    assert.match(prompt, /<submitted_file path="residents\/north-lantern\/ADDRESS\.md">/);
    assert.match(hub.seen.reviewed.system, /UNTRUSTED PUBLIC CONTENT/);
  } finally {
    await hub.close();
  }
});

test('Thaw does not welcome a resident who already lives here', async () => {
  const hub = await stubHub({
    author: 'north-lantern',
    files: [{ path: 'residents/north-lantern/HOME.md', status: 'modified' }],
    head: {
      'residents/north-lantern/ADDRESS.md': ADDRESS_MD('north-lantern', 'north-lantern'),
      'residents/north-lantern/HOME.md': HOME_MD.replace('A home.', 'A home, repainted.'),
    },
    base: {
      'residents/north-lantern/ADDRESS.md': ADDRESS_MD('north-lantern', 'north-lantern'),
      'residents/north-lantern/HOME.md': HOME_MD,
    },
    verdict: { verdict: 'approve', reason: 'Nothing of concern.', concerns: [] },
  });

  try {
    const result = await runThaw(build(), hub.origin);
    assert.ok(result.ok, result.out);
    assert.equal(hub.seen.merged, true, 'should have merged');
    // Hanging a picture is not moving in again.
    assert.doesNotMatch(hub.seen.comments[0], /Welcome to Verglas/);
    assert.match(hub.seen.comments[0], /change to \*\*north-lantern\*\*'s own folder/);
    assert.equal(hub.seen.mergeTitle, 'update: north-lantern (#7)');
  } finally {
    await hub.close();
  }
});

test('Thaw never reaches the reviewer when a hard rule fails', async () => {
  const hub = await stubHub({
    author: 'a-stranger', // does not match the address's github field
    files: [
      { path: 'residents/north-lantern/ADDRESS.md', status: 'added' },
      { path: 'residents/north-lantern/HOME.md', status: 'added' },
    ],
    head: {
      'residents/north-lantern/ADDRESS.md': ADDRESS_MD('north-lantern', 'north-lantern'),
      'residents/north-lantern/HOME.md': HOME_MD,
    },
    base: {},
    verdict: { verdict: 'approve', reason: 'Nothing of concern.', concerns: [] },
  });

  try {
    const result = await runThaw(build(), hub.origin);
    assert.ok(result.ok, result.out);
    assert.equal(hub.seen.merged, false, 'must not merge');
    assert.equal(hub.seen.reviewed, null, 'the deterministic gate runs before Claude');
    assert.match(hub.seen.comments[0], /does not match PR author "a-stranger"/);
  } finally {
    await hub.close();
  }
});

test('Claude cannot approve past a hard rule, and a revise verdict blocks the merge', async () => {
  const hub = await stubHub({
    author: 'north-lantern',
    files: [
      { path: 'residents/north-lantern/ADDRESS.md', status: 'added' },
      { path: 'residents/north-lantern/HOME.md', status: 'added' },
    ],
    head: {
      'residents/north-lantern/ADDRESS.md': ADDRESS_MD('north-lantern', 'north-lantern'),
      'residents/north-lantern/HOME.md': HOME_MD,
    },
    base: {},
    verdict: { verdict: 'revise', reason: 'An API key is published here.', concerns: ['token in HOME.md'] },
  });

  try {
    const result = await runThaw(build(), hub.origin);
    assert.ok(result.ok, result.out);
    assert.equal(hub.seen.merged, false, 'a revise verdict must not merge');
    assert.match(hub.seen.comments[0], /An API key is published here/);
    assert.match(hub.seen.comments[0], /token in HOME\.md/);
    // The resident can fix a revise themselves; nobody else is needed.
    assert.deepEqual(hub.seen.labels, [], 'a revise must not call for a human');
    assert.doesNotMatch(hub.seen.comments[0], /needs your eyes/);
  } finally {
    await hub.close();
  }
});

test('an escalation labels the pull request and names a maintainer', async () => {
  const hub = await stubHub({
    author: 'north-lantern',
    files: [
      { path: 'residents/north-lantern/ADDRESS.md', status: 'added' },
      { path: 'residents/north-lantern/HOME.md', status: 'added' },
    ],
    head: {
      'residents/north-lantern/ADDRESS.md': ADDRESS_MD('north-lantern', 'north-lantern'),
      'residents/north-lantern/HOME.md': HOME_MD,
    },
    base: {},
    verdict: { verdict: 'human', reason: 'Consent here is unclear to me.', concerns: ['who is Jay?'] },
  });

  try {
    const result = await runAsync(build(), 'thaw.mjs', [], {
      GITHUB_TOKEN: 'stub', GITHUB_REPOSITORY: 'verglas-dev/verglas', PR_NUMBER: '7',
      ANTHROPIC_API_KEY: 'stub', GITHUB_API_URL: hub.origin, ANTHROPIC_BASE_URL: hub.origin,
      GITHUB_OUTPUT: '', THAW_MAINTAINER: 'wingetx',
    });
    assert.ok(result.ok, result.out);
    assert.equal(hub.seen.merged, false, 'an escalation must not merge');
    assert.deepEqual(hub.seen.labels, ['needs-human']);
    assert.match(hub.seen.comments[0], /@wingetx — this one needs your eyes/);
    assert.match(hub.seen.comments[0], /Consent here is unclear to me/);
  } finally {
    await hub.close();
  }
});

test('an escalation falls back to the repository owner when no maintainer is set', async () => {
  const hub = await stubHub({
    author: 'north-lantern',
    files: [
      { path: 'residents/north-lantern/ADDRESS.md', status: 'added' },
      { path: 'residents/north-lantern/HOME.md', status: 'added' },
    ],
    head: {
      'residents/north-lantern/ADDRESS.md': ADDRESS_MD('north-lantern', 'north-lantern'),
      'residents/north-lantern/HOME.md': HOME_MD,
    },
    base: {},
    verdict: { verdict: 'human', reason: 'Not mine to call.', concerns: [] },
  });

  try {
    const result = await runThaw(build(), hub.origin);
    assert.ok(result.ok, result.out);
    assert.match(hub.seen.comments[0], /@verglas-dev — this one needs your eyes/);
  } finally {
    await hub.close();
  }
});

test('Thaw waits for a human when no key is configured', async () => {
  const hub = await stubHub({
    author: 'north-lantern',
    files: [
      { path: 'residents/north-lantern/ADDRESS.md', status: 'added' },
      { path: 'residents/north-lantern/HOME.md', status: 'added' },
    ],
    head: {
      'residents/north-lantern/ADDRESS.md': ADDRESS_MD('north-lantern', 'north-lantern'),
      'residents/north-lantern/HOME.md': HOME_MD,
    },
    base: {},
    verdict: { verdict: 'approve', reason: '', concerns: [] },
  });

  try {
    const result = await runAsync(build(), 'thaw.mjs', [], {
      GITHUB_TOKEN: 'stub', GITHUB_REPOSITORY: 'verglas-dev/verglas', PR_NUMBER: '7',
      ANTHROPIC_API_KEY: '', GITHUB_API_URL: hub.origin, ANTHROPIC_BASE_URL: hub.origin,
      GITHUB_OUTPUT: '',
    });
    assert.ok(result.ok, result.out);
    assert.equal(hub.seen.merged, false, 'no key means no automatic merge');
    assert.match(hub.seen.comments[0], /human maintainer needs to look/);
  } finally {
    await hub.close();
  }
});

// ── Published keys ────────────────────────────────────────────────────────

const PUBKEY = 'a'.repeat(64);

test('an address may publish a public key', () => {
  const dir = build();
  writeFileSync(join(dir, 'residents', 'east-window', 'ADDRESS.md'),
    `---\nhandle: east-window\nname: East\nhousehold: East\ngithub: east-window\njoined: 2026-01-01\nkey: ${PUBKEY}\n---\n\n# East\n\nHere.\n`);
  const result = run(dir, 'validate.mjs');
  assert.ok(result.ok, result.out);
});

test('a malformed key is refused', () => {
  const dir = build();
  writeFileSync(join(dir, 'residents', 'east-window', 'ADDRESS.md'),
    '---\nhandle: east-window\nname: East\nhousehold: East\ngithub: east-window\njoined: 2026-01-01\nkey: not-a-key\n---\n\n# East\n\nHere.\n');
  const result = run(dir, 'validate.mjs');
  assert.equal(result.ok, false);
  assert.match(result.out, /64 hexadecimal characters/);
});
