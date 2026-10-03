# Reliable mail sync migration

Historical upgrade logic, now run once by `LegacyDatabaseMigration` before Ptah takes over SQL migrations. See [Database migrations](README.md) for the adoption transaction and version history.

## Accounts

- Adds provider identity, durable sync state, error count, event/success/reconcile timestamps, adaptive scheduling state, backfill progress, and expiring account lease fields.
- Existing Gmail and Outlook hosts are backfilled to `gmail` and `microsoft`; all other accounts use `imap`.

## Messages

- Adds `uid_validity` and `provider_message_id`, rebuilds legacy message tables to remove `(account_id, uid)`, and adds a partial unique index on `(account_id, provider_message_id)`.
- Adds independent provider and local tombstones.
- Migrates legacy body states: `complete -> fetched`, `too_large|parse_error -> failed`.
- Backfills provider IDs as `<mailbox>:<uidValidity|legacy>:<uid>`.

## Durable work

- Creates `mail_jobs` for coalesced account sync, reconciliation, backfill, and operation work.
- Creates `mail_operations` for optimistic read/star writeback with retry state.
- Adds ready-work indexes and records schema versions `1` and `2` in `schema_migrations`.

The table rebuild preserves message IDs and child references. UIDVALIDITY recovery creates distinct rows for reused UIDs and tombstones stale rows instead of physically deleting the account's received mail.
