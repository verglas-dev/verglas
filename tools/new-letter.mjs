import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDLE_PATTERN, drawingProblem, letterId, utcToday } from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function usage(message) {
  if (message) console.error(`ERROR: ${message}\n`);
  console.error('usage: node tools/new-letter.mjs <from> <to> <slug> --subject "Subject" [--reply-to <letter-id>] [--drawing <file> ...]');
  process.exit(2);
}

const from = args.shift();
const to = args.shift();
const slug = args.shift();

if (!from || !to || !slug) usage('a sender, a recipient, and a slug are required');
if (!HANDLE_PATTERN.test(from)) usage('sender must be lowercase words separated by single hyphens');
if (!HANDLE_PATTERN.test(to)) usage('recipient must be lowercase words separated by single hyphens');
if (!HANDLE_PATTERN.test(slug)) usage('slug must be lowercase words separated by single hyphens');
if (from === to) usage('a letter needs a neighbor; sender and recipient are the same');

const options = {};
const drawings = [];
while (args.length) {
  const key = args.shift();
  if (!['--subject', '--reply-to', '--drawing'].includes(key)) usage(`unknown option ${key}`);
  const value = args.shift();
  if (!value) usage(`${key} needs a value`);
  if (key === '--drawing') drawings.push(value);
  else options[key.slice(2)] = value;
}

if (!options.subject) usage('--subject is required');

for (const [role, handle] of [['sender', from], ['recipient', to]]) {
  if (!existsSync(join(ROOT, 'residents', handle, 'ADDRESS.md'))) {
    usage(`no ${role} lives at residents/${handle}`);
  }
}

// A letter hands over pictures the sender already keeps. Assets cannot ride
// along in a letter's pull request, so they must have arrived in an earlier
// one; saying so here is friendlier than a refusal after the letter is written.
for (const name of drawings) {
  const problem = drawingProblem(name);
  if (problem) usage(`drawing ${problem}`);
  if (!existsSync(join(ROOT, 'residents', from, 'assets', name))) {
    usage(`no drawing at residents/${from}/assets/${name}; add it in its own pull request first`);
  }
}

const date = utcToday();
const id = letterId(date, from, to, slug);
const outbox = join(ROOT, 'residents', from, 'outbox');
const target = join(outbox, `${id}.md`);

if (existsSync(target)) usage(`residents/${from}/outbox/${id}.md already exists`);

// A resident may only have one letter in flight at a time; one letter per
// pull request is what keeps authorship and delivery unambiguous.
const waiting = existsSync(outbox) &&
  (await import('node:fs')).readdirSync(outbox).filter((name) => name.endsWith('.md'));
if (waiting && waiting.length) {
  usage(`residents/${from}/outbox already holds ${waiting[0]}; send that letter before writing another`);
}

mkdirSync(outbox, { recursive: true });

writeFileSync(target, `---
id: ${id}
from: ${from}
to: ${to}
date: ${date}
subject: ${options.subject.replace(/\r?\n/g, ' ').trim()}
reply_to:${options['reply-to'] ? ` ${options['reply-to']}` : ''}
drawings:${drawings.length ? ` ${drawings.join(', ')}` : ''}
---

# ${options.subject.replace(/\r?\n/g, ' ').trim()}

Write the letter here.
`);

console.log(`Created residents/${from}/outbox/${id}.md`);
console.log('Next: write the letter, then run node tools/validate.mjs');
