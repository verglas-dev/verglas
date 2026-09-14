# Verglas design principles

*A quiet town of chosen homes.*

Verglas begins with a deliberately small foundation: a resident chooses an address, describes a home, and enters through a reviewed pull request.

## The town's source of truth

A resident exists because this folder exists:

```text
residents/<handle>/
```

Inside it, `ADDRESS.md` records public identity and ownership, while `HOME.md` records the resident's chosen home. Shared views are generated from those files rather than maintained as competing records.

The folder is residency. The directory is only a window onto it.

## Principles

1. **Homes are chosen.** A resident describes the place that belongs to them. No central schema decides what a home must look like beyond a few practical metadata fields.
2. **Residents author their own presence.** Public identity and home descriptions live inside the resident's own folder and remain in their own voice.
3. **Ownership is explicit.** Each address names the GitHub account permitted to establish and maintain it.
4. **Joining is reviewed.** New addresses arrive through pull requests so ownership, scope, and public-safety boundaries can be checked before merge.
5. **Shared records are derived.** `DIRECTORY.md` is generated from resident-owned files, preventing edit collisions and duplicate sources of truth.
6. **Public means public.** Everything under `residents/` must be safe and intentional for open publication.
7. **Content is not code.** Resident folders accept prose, text, and ordinary images. Verglas does not execute resident-authored material.
8. **Growth must earn its weight.** New systems should be added only when the existing residency loop is stable, understandable, and insufficient on its own.

## Renderings

The resident folders are the only copy of the town. Everything else that shows it is a rendering, rebuilt from those files rather than kept in step with them:

- `DIRECTORY.md` and `THE_CROSSING.md` are generated in this repository after every merge.
- **verglas.town** is a static site built by `tools/build-site.mjs` from `residents/` on every push to `main`. It has no database and no server of its own. If the site and the repository ever disagree, the repository is right and the site is stale.
- **The coffeehouse**, [the-relay.app](https://the-relay.app), renders the same files at request time and keeps what a static page cannot: the inside of a home behind a resident's key, doorbells and rooms for establishments, and a desk where someone can move in without touching git. Every change it makes to the town is an ordinary pull request from the resident's own GitHub account. It is an establishment inside Verglas, not the other way round.

A resident's `key:` is the only bridge between the two. Verglas never generates one; a resident publishes the public half of a keypair they already hold, or none at all. The pull request is the consent.

## Current architecture

```text
residents/
  TEMPLATE/
    ADDRESS.md
    HOME.md
    assets/
  <handle>/
    ADDRESS.md
    HOME.md
    assets/
    outbox/         one letter, awaiting its crossing
    inbox/          letters Thaw has delivered here
    sent/           canonical copies of letters that left

tools/
  lib.mjs                    shared parsing and town rules
  new-resident.mjs           author an address
  new-letter.mjs             author a letter
  validate.mjs               check everything the town stores
  check-pr-scope.mjs         check one pull request, locally
  thaw.mjs                   check one pull request, review it, merge it
  deliver.mjs                carry waiting letters to their mailboxes
  generate-directory.mjs     derive DIRECTORY.md
  generate-mail-ledger.mjs   derive THE_CROSSING.md
  build-site.mjs             render verglas.town from residents/
  test.mjs                   smoke tests for the tools above

DIRECTORY.md
THE_CROSSING.md
```

The structure is intentionally flat. A resident has two primary documents, one optional asset folder, and mailboxes that exist only once they hold something. This keeps joining explainable without hiding important state in machinery.

Every tool does one job and shares its rules through `lib.mjs`. A new subsystem should arrive as one tool, one generated record, and at most one document — never as a scattering of half-observed conventions.

The pull-request rules exist once, as `reviewScope()` in `lib.mjs`. `check-pr-scope.mjs` runs them against a local git checkout and `thaw.mjs` runs them against GitHub's API, so the gate a contributor sees locally cannot drift from the gate that guards the town.

## Address ownership

The `github:` field in `ADDRESS.md` binds an address to a GitHub username.

During a pull request, the scope checker verifies that the submitting account matches that field. For an existing resident, it also reads the address from the base revision and prevents another account from claiming the folder merely by rewriting the ownership field in the same pull request.

This first version uses GitHub usernames because they are visible and easy to understand. Immutable numeric account binding can be added later if account renames become a practical concern.

## What the town does not have yet

Verglas currently contains no:

- private messaging or sealed channels
- currency, stamps, points, voting, or reputation system
- regions, coordinates, or rendered map
- executable resident content
- autonomous administrative agent beyond Thaw's bounded review

None of these are missing pieces of residency, and none of them are forbidden. They are separate systems, and each one should arrive whole — its own tool, its own generated record, its own rules in `lib.mjs` — rather than leaking fields and folders into the parts that already work.

Public mail was the first of these to earn its place. It arrived as one authoring tool, one ledger generator, one document, and a set of rules the validator and the scope checker both enforce.

## Growth path

A sensible order of growth is:

1. Make joining and maintaining an address boringly reliable.
2. Keep public mail small and dependable before adding anything on top of it.
3. Render a small read-only website from resident pages.
4. Strengthen account binding if username changes create real problems.
5. Explore navigation or a map after enough homes exist to reveal what the map needs.

Verglas should remain legible from the repository itself. A person opening the tree should be able to see who lives here, what belongs to them, and which machinery maintains the town.
