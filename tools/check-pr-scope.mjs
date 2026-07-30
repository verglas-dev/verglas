import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeGithubLogin, reviewScope } from './lib.mjs';

// The local half of the gate: same rules as Thaw applies, read from git
// instead of GitHub's API. The rules themselves live in lib.mjs.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const actor = normalizeGithubLogin(process.env.GITHUB_ACTOR);
const baseSha = process.env.BASE_SHA;
const headSha = process.env.HEAD_SHA || 'HEAD';

if (!actor || !baseSha) {
  console.error('ERROR: GITHUB_ACTOR and BASE_SHA are required');
  process.exit(2);
}

const diff = execFileSync(
  'git',
  ['diff', '--name-status', '--find-renames', `${baseSha}...${headSha}`],
  { cwd: ROOT, encoding: 'utf8' }
).trim();

const files = diff
  ? diff.split('\n').map((line) => {
      const parts = line.split('\t');
      return { status: parts[0], path: parts.at(-1) };
    })
  : [];

// validate.yml also runs on tools/ and workflow changes. Those are maintainer
// work, not resident submissions, and the resident gate has nothing to say
// about them -- asked anyway, it refuses every path for not living under
// residents/, so no maintainer pull request could ever pass.
//
// Only a pull request that touches no resident folder at all is outside the
// gate. One that mixes the two still goes through it, and the stray paths are
// still refused: that check is what stops a resident slipping a change to the
// town's own machinery in beside their address.
if (!files.some((file) => file.path.startsWith('residents/'))) {
  console.log('No resident folders in this pull request; the resident scope check does not apply.');
  process.exit(0);
}

const { kind, handle, letter, errors } = await reviewScope({
  files,
  actor,
  readHead: (path) => {
    const full = join(ROOT, path);
    return existsSync(full) ? readFileSync(full, 'utf8') : null;
  },
  readBase: (path) => {
    try {
      return execFileSync('git', ['show', `${baseSha}:${path}`], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  },
  listBase: () => {
    try {
      const entries = execFileSync('git', ['ls-tree', '--name-only', `${baseSha}:residents`], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      return entries.split('\n')
        .map((name) => name.replace(/\/$/, '').trim())
        .filter((name) => name && name !== 'TEMPLATE');
    } catch {
      // A base with no residents/ at all: the first arrival holds nothing yet.
      return [];
    }
  },
});

for (const error of errors) console.error(`ERROR ${error}`);
if (errors.length) {
  console.error(`\nPull-request scope check failed with ${errors.length} error(s).`);
  process.exit(1);
}

if (kind === 'letter') {
  console.log(`Letter scope check passed for @${actor}: ${handle} writes to ${letter.to}.`);
} else {
  console.log(`Address scope check passed for @${actor}: ${handle}.`);
}
