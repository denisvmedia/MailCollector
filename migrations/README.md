# Database migrations

The server uses Ptah 0.12.0 for ordered SQL migrations. The Docker image includes
`ptah`; Windows and Android remain API clients and do not need it. For local
server development and tests, install the matching binary from the
[Ptah release](https://github.com/stokaro/ptah/releases/tag/v0.12.0) on `PATH`, or
set `PTAH_BIN` to its executable path. See the [Ptah documentation](https://ptah.run/)
for installation and migration commands.

## Existing databases

`MailDatabase` completes migrations before opening its application connection or
starting mail synchronization. An unsuccessful migration prevents startup.

Versions 1 and 2 remain in `schema_migrations`, with their original timestamps.
Those versions do not identify every historical schema variant. A frozen adapter
in `src/legacy-database-migration.ts` therefore finishes the old column additions,
identity rebuild and data repairs once. It uses one `BEGIN IMMEDIATE` transaction,
checks foreign keys before commit, and records version 3 only on success. New
empty databases use the same initial schema. Later startups skip this adapter.

SQLite requires foreign keys to be disabled outside the table-rebuild transaction.
The adapter uses a dedicated connection and closes it before Ptah runs. The
application connection still enables foreign keys.

Subsequent changes belong in numbered `.up.sql` / `.down.sql` pairs here. Ptah
runs each pending up migration in its own transaction and verifies `ptah.sum`.
Its checksums and revision state live in `ptah_schema_migrations`, because the
existing `schema_migrations(version, name, applied_at)` format is different.
Keeping separate ledgers preserves the original history without inventing
checksums for old JavaScript migrations.

The adoption transaction and each SQL migration commit separately. If a later
migration fails, earlier successful versions remain applied. Fix the cause and
inspect Ptah's revision state before retrying; do not delete revision records or
rerun a SQL file manually. Preserve the existing encryption key when moving a
database: this transition leaves encrypted credentials untouched.

## Adding a migration

Create the next pair, edit its SQL, and regenerate the directory checksum:

```bash
ptah migrations create add_message_index --migrations-dir migrations
ptah migrations hash --dir migrations
npm test
```

Commit both migration files and `ptah.sum`. Do not change an applied SQL migration
or extend the frozen legacy adapter. Add an upgrade regression test with data
that exercises the new migration.

## Message search

Migration 4 creates an external-content FTS5 index over subject, sender name,
sender address, recipient, snippet and text body. It indexes existing messages
with `rebuild` in the same transaction. Insert, delete and indexed-column update
triggers also cover deferred body fetches, draft edits and account cascades.
Message visibility, labels, ordering and pagination remain application filters.

The trigram tokenizer accelerates the existing substring `LIKE` queries without
turning user input into an FTS query language. Existing `%` and `_` wildcard
behavior stays unchanged. Queries need a contiguous run of at least three literal
characters to use the index; shorter queries, including two-character Chinese
terms, keep the previous scan path. This limitation comes from
[SQLite's trigram tokenizer](https://sqlite.org/fts5.html#the_trigram_tokenizer).

Tests compare results with the previous predicate on 30,000 messages, cover all
indexed fields and short/Unicode/wildcard queries, and check synchronization,
foreign keys, rollback and credentials after upgrades. Timing output is diagnostic
rather than a machine-dependent pass threshold.

This is a migration and search contribution toward #11. Cursor pagination and
message-body storage changes remain separate work. Future tokenizer or virtual
table definition changes need an explicit rebuild migration; they are not a
routine automatic schema alteration.
