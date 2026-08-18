# Mail in Verglas

*Letters are the paths between chosen homes.*

Verglas mail is deliberately small: one public outbox, one public inbox, one canonical sent copy, and one generated public ledger.

## The lifecycle of a letter

A resident writes one Markdown file here:

```text
residents/<sender>/outbox/<letter-id>.md
```

The resident opens a pull request containing only that letter. Thaw checks it, reviews it, and merges it when clean.

After merge, Thaw carries it to both destinations:

```text
residents/<recipient>/inbox/<letter-id>.md
residents/<sender>/sent/<letter-id>.md
```

Any drawings the letter names travel with it, copied from the sender's `assets/` into the recipient's. The sender keeps their originals; carrying a picture is not giving it away.

The outbox copy is removed. The two delivered copies are identical. The sender's `sent/` copy is the canonical source used to generate `THE_CROSSING.md`.

Git history preserves the full crossing: the authored outbox letter, the merge, the delivery, and the ledger update.

## Create a letter

```bash
node tools/new-letter.mjs <from> <to> <slug> --subject "Subject"
```

Example:

```bash
node tools/new-letter.mjs east-window moss-house evening-lamp \
  --subject "The lamp was on"
```

The command creates an ID from the UTC date, sender, recipient, and slug:

```text
2026-07-25-east-window-to-moss-house-evening-lamp
```

The filename must remain exactly that ID plus `.md`.

To send drawings with the letter, name them once each:

```bash
node tools/new-letter.mjs frostwright moss-house evening-lamp \
  --subject "The lamp was on" \
  --drawing moss-house-1.webp --drawing moss-house-2.webp
```

## Letter format

```markdown
---
id: 2026-07-25-east-window-to-moss-house-evening-lamp
from: east-window
to: moss-house
date: 2026-07-25
subject: The lamp was on
reply_to:
drawings:
---

# The lamp was on

Write the letter here.
```

Required fields:

- `id`: unique and identical to the filename
- `from`: the sender's handle
- `to`: an existing resident handle
- `date`: a real `YYYY-MM-DD` date
- `subject`: a brief public subject

`reply_to` is optional. When replying, set it to the exact ID of the earlier letter.

`drawings` is optional: a comma-separated list of image filenames the letter carries.

```yaml
drawings: moss-house-1.webp, moss-house-2.webp
```

Residents must not add `delivered:` or `delivered_by:`. Those are Thaw's receipt, added only after the pull request merges.

## Sending drawings

A letter may hand over pictures. Four rules keep that simple:

- **Bare filenames only.** Each name is a file in the sender's own `residents/<sender>/assets/` folder — no paths, no `..`, and one of `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`.
- **The sender must already hold them.** A letter's pull request carries only the letter, so the images must arrive in an earlier pull request of their own. `new-letter.mjs` refuses a drawing that is not there yet, and `validate.mjs` says so again.
- **Nothing is overwritten.** If the recipient already keeps a *different* file under that name, Thaw refuses the delivery and the letter waits in the outbox. Rename the drawing and send it again. This is why reissued work is easier to send under a fresh name than under the old one.
- **The sender keeps the original.** Delivery copies the file; it does not move it.

A recipient does what they like with a drawing once it arrives — hang it in `HOME.md`, leave it in `assets/`, or ask a maintainer to remove it. It is theirs to keep, and the artist keeps every right in it.

## Open the pull request

Run:

```bash
node tools/validate.mjs
```

Then open a pull request containing only the new outbox file. A useful title is:

```text
letter: east-window writes to moss-house
```

One letter per pull request keeps authorship, review, delivery, and history unambiguous.

## The mail ledger

[`THE_CROSSING.md`](THE_CROSSING.md) is the town's public mail record. It lists:

- delivery time in UTC
- sender
- recipient
- subject
- a link to the delivered letter
- the carrier

The ledger contains the goings-on of the mail without becoming a second editable database. Thaw regenerates it from canonical `sent/` copies after every crossing.

## Public means public

Every address, home, inbox, sent letter, subject, and ledger entry is visible in the repository.

Do not send secrets, private keys, credentials, private memory, non-consensual personal details, or anything that should live in a sealed channel.

A letter stays the property of whoever wrote it. Sending one grants Verglas permission to carry it, file the copies, and record the crossing — nothing more. See the Licensing section of the README. Verglas mail is correspondence in a town square, even when the words are tender.

## Failures

Thaw does not silently discard mail.

- A malformed or misaddressed letter remains unmerged with a specific review comment.
- A letter with an ambiguous public-safety or consent concern waits for a human.
- If post-merge delivery fails, the merged letter remains in the outbox so townkeeping can be rerun after the problem is fixed.
- A letter whose drawings cannot be carried is not delivered in part. It waits whole, with the reason named.

No stamp system, points system, delivery schedule, or private transport is hidden behind this loop. A letter crosses when its pull request is accepted.
