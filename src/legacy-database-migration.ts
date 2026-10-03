import crypto from "node:crypto";
import type Database from "better-sqlite3";

// Frozen pre-Ptah upgrade path. Older databases sharing versions 1 and 2 can
// have different columns. The caller runs this once, inside one transaction
// with foreign keys disabled, checks references, and records version 3.
// Add future changes as SQL files in migrations/, not to this adapter.
export class LegacyDatabaseMigration {
  constructor(private readonly db: Database.Database) {}

  run(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id TEXT NOT NULL,
        sync_updated_at TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        secure INTEGER NOT NULL DEFAULT 1,
        username TEXT NOT NULL,
        encrypted_password TEXT NOT NULL,
        mailbox TEXT NOT NULL DEFAULT 'INBOX',
        provider TEXT NOT NULL DEFAULT 'imap',
        enabled INTEGER NOT NULL DEFAULT 1,
        uid_validity TEXT,
        last_uid INTEGER NOT NULL DEFAULT 0,
        last_sync_at TEXT,
        last_successful_sync_at TEXT,
        last_reconcile_at TEXT,
        last_event_at TEXT,
        last_error TEXT,
        sync_error_count INTEGER NOT NULL DEFAULT 0,
        sync_state TEXT NOT NULL DEFAULT 'idle',
        next_sync_at TEXT,
        backfill_cursor INTEGER,
        backfill_status TEXT NOT NULL DEFAULT 'pending',
        lease_owner TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        uid INTEGER NOT NULL,
        uid_validity TEXT,
        provider_message_id TEXT,
        message_id TEXT,
        subject TEXT NOT NULL DEFAULT '',
        from_name TEXT,
        from_address TEXT,
        to_text TEXT,
        received_at TEXT NOT NULL,
        text_body TEXT,
        html_body TEXT,
        snippet TEXT NOT NULL DEFAULT '',
        has_attachments INTEGER NOT NULL DEFAULT 0,
        is_read INTEGER NOT NULL DEFAULT 1,
        is_starred INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        body_status TEXT NOT NULL DEFAULT 'fetched',
        body_error TEXT,
        body_retryable INTEGER NOT NULL DEFAULT 1,
        body_fetch_started_at TEXT,
        provider_deleted INTEGER NOT NULL DEFAULT 0,
        local_deleted INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        folder TEXT NOT NULL DEFAULT 'inbox' CHECK(folder IN ('inbox', 'archive', 'trash', 'spam')),
        snoozed_until TEXT,
        kind TEXT NOT NULL DEFAULT 'received' CHECK(kind IN ('received', 'draft', 'sent')),
        cc_text TEXT,
        bcc_text TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS messages_received_at_idx ON messages(received_at DESC);
      CREATE INDEX IF NOT EXISTS messages_account_id_idx ON messages(account_id);

      CREATE TABLE IF NOT EXISTS app_users (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        email TEXT NOT NULL,
        normalized_email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS app_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS app_sessions_expires_at_idx ON app_sessions(expires_at);
    `);

    const appUserColumns = this.db.prepare("PRAGMA table_info(app_users)").all() as Array<{ name: string }>;
    if (appUserColumns.some((column) => column.name === "username") && !appUserColumns.some((column) => column.name === "email")) {
      this.db.exec("ALTER TABLE app_users RENAME COLUMN username TO email");
      this.db.exec("ALTER TABLE app_users RENAME COLUMN normalized_username TO normalized_email");
    }

    this.addColumnIfMissing("accounts", "uid_validity", "TEXT");
    this.addColumnIfMissing("accounts", "sync_id", "TEXT");
    this.addColumnIfMissing("accounts", "sync_updated_at", "TEXT");
    this.addColumnIfMissing("accounts", "provider", "TEXT NOT NULL DEFAULT 'imap'");
    this.addColumnIfMissing("accounts", "last_successful_sync_at", "TEXT");
    this.addColumnIfMissing("accounts", "last_reconcile_at", "TEXT");
    this.addColumnIfMissing("accounts", "last_event_at", "TEXT");
    this.addColumnIfMissing("accounts", "sync_error_count", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("accounts", "sync_state", "TEXT NOT NULL DEFAULT 'idle'");
    this.addColumnIfMissing("accounts", "next_sync_at", "TEXT");
    this.addColumnIfMissing("accounts", "backfill_cursor", "INTEGER");
    this.addColumnIfMissing("accounts", "backfill_status", "TEXT NOT NULL DEFAULT 'pending'");
    this.addColumnIfMissing("accounts", "lease_owner", "TEXT");
    this.addColumnIfMissing("accounts", "lease_expires_at", "TEXT");
    this.addColumnIfMissing("messages", "provider_message_id", "TEXT");
    this.addColumnIfMissing("messages", "uid_validity", "TEXT");
    this.addColumnIfMissing("messages", "body_status", "TEXT NOT NULL DEFAULT 'complete'");
    this.addColumnIfMissing("messages", "body_error", "TEXT");
    this.addColumnIfMissing("messages", "is_read", "INTEGER NOT NULL DEFAULT 1");
    this.addColumnIfMissing("messages", "is_starred", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("messages", "folder", "TEXT NOT NULL DEFAULT 'inbox'");
    this.addColumnIfMissing("messages", "snoozed_until", "TEXT");
    this.addColumnIfMissing("messages", "kind", "TEXT NOT NULL DEFAULT 'received'");
    this.addColumnIfMissing("messages", "cc_text", "TEXT");
    this.addColumnIfMissing("messages", "bcc_text", "TEXT");
    this.addColumnIfMissing("messages", "provider_deleted", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("messages", "local_deleted", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("messages", "body_retryable", "INTEGER NOT NULL DEFAULT 1");
    this.addColumnIfMissing("messages", "body_fetch_started_at", "TEXT");
    this.addColumnIfMissing("messages", "deleted_at", "TEXT");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        built_in INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS message_labels (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
        PRIMARY KEY (message_id, label_id)
      );

      CREATE INDEX IF NOT EXISTS messages_folder_idx ON messages(folder, received_at DESC);
      CREATE INDEX IF NOT EXISTS messages_kind_idx ON messages(kind, received_at DESC);
      CREATE INDEX IF NOT EXISTS messages_snoozed_until_idx ON messages(snoozed_until);
      CREATE INDEX IF NOT EXISTS message_labels_label_id_idx ON message_labels(label_id, message_id);
      CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_id_idx ON messages(account_id, provider_message_id) WHERE provider_message_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS mail_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        priority INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT 'scheduled',
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        run_after TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        rerun_requested INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, type)
      );

      CREATE INDEX IF NOT EXISTS mail_jobs_ready_idx ON mail_jobs(status, run_after, priority, id);

      CREATE TABLE IF NOT EXISTS mail_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        uid INTEGER NOT NULL,
        uid_validity TEXT NOT NULL DEFAULT '',
        operation TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 8,
        next_retry_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS mail_operations_ready_idx ON mail_operations(status, next_retry_at, id);

      INSERT OR IGNORE INTO labels (name, built_in) VALUES ('工作', 1), ('个人', 1), ('订阅', 1);
    `);
    this.addColumnIfMissing("messages", "auto_label_id", "INTEGER REFERENCES labels(id)");
    this.addColumnIfMissing("mail_operations", "uid_validity", "TEXT NOT NULL DEFAULT ''");
    const accountSyncMetadata = this.db.prepare("SELECT id, sync_id AS syncId, sync_updated_at AS syncUpdatedAt, created_at AS createdAt FROM accounts").all() as Array<{ id: number; syncId: string | null; syncUpdatedAt: string | null; createdAt: string }>;
    const updateSyncMetadata = this.db.prepare("UPDATE accounts SET sync_id = ?, sync_updated_at = ? WHERE id = ?");
    for (const account of accountSyncMetadata) {
      const timestamp = account.syncUpdatedAt || account.createdAt;
      const explicitTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp) ? `${timestamp.replace(" ", "T")}Z` : timestamp;
      const parsedTimestamp = Date.parse(explicitTimestamp);
      updateSyncMetadata.run(account.syncId || crypto.randomUUID(), Number.isFinite(parsedTimestamp) ? new Date(parsedTimestamp).toISOString() : new Date().toISOString(), account.id);
    }
    this.db.prepare("UPDATE accounts SET provider = CASE WHEN lower(host) = 'imap.gmail.com' THEN 'gmail' WHEN lower(host) = 'outlook.office365.com' THEN 'microsoft' ELSE 'imap' END WHERE provider = 'imap'").run();
    this.db.prepare("UPDATE messages SET body_status = 'fetched' WHERE body_status = 'complete'").run();
    this.db.prepare("UPDATE messages SET body_status = 'failed' WHERE body_status IN ('too_large', 'parse_error')").run();
    this.db.prepare(`
      UPDATE messages SET provider_message_id = (
        SELECT accounts.mailbox || ':' || COALESCE(accounts.uid_validity, 'legacy') || ':' || messages.uid
        FROM accounts WHERE accounts.id = messages.account_id
      ) WHERE provider_message_id IS NULL AND kind = 'received'
    `).run();
    this.db.prepare(`
      UPDATE messages SET uid_validity = (
        SELECT accounts.uid_validity FROM accounts WHERE accounts.id = messages.account_id
      ) WHERE uid_validity IS NULL AND kind = 'received'
    `).run();
    this.rebuildLegacyMessageIdentity();
    this.db.prepare(`
      UPDATE mail_operations SET uid_validity = (
        SELECT messages.uid_validity FROM messages WHERE messages.id = mail_operations.message_id
      ) WHERE uid_validity = ''
    `).run();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS messages_received_at_idx ON messages(received_at DESC);
      CREATE INDEX IF NOT EXISTS messages_account_id_idx ON messages(account_id);
      CREATE INDEX IF NOT EXISTS messages_account_uid_idx ON messages(account_id, uid_validity, uid);
      CREATE INDEX IF NOT EXISTS messages_folder_idx ON messages(folder, received_at DESC);
      CREATE INDEX IF NOT EXISTS messages_kind_idx ON messages(kind, received_at DESC);
      CREATE INDEX IF NOT EXISTS messages_snoozed_until_idx ON messages(snoozed_until);
      CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_id_idx ON messages(account_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_sync_id_idx ON accounts(sync_id);
    `);
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (1, 'reliable_mail_sync')").run();
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (2, 'uidvalidity_message_identity')").run();
  }

  private addColumnIfMissing(table: "accounts" | "messages" | "mail_operations", column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private rebuildLegacyMessageIdentity(): void {
    const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get() as { sql: string } | undefined;
    if (!schema || !/UNIQUE\s*\(\s*account_id\s*,\s*uid\s*\)/i.test(schema.sql)) return;
    this.db.exec(`
      CREATE TABLE messages_reliable_sync (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        uid INTEGER NOT NULL,
        uid_validity TEXT,
        provider_message_id TEXT,
        message_id TEXT,
        subject TEXT NOT NULL DEFAULT '',
        from_name TEXT,
        from_address TEXT,
        to_text TEXT,
        received_at TEXT NOT NULL,
        text_body TEXT,
        html_body TEXT,
        snippet TEXT NOT NULL DEFAULT '',
        has_attachments INTEGER NOT NULL DEFAULT 0,
        is_read INTEGER NOT NULL DEFAULT 1,
        is_starred INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        body_status TEXT NOT NULL DEFAULT 'fetched',
        body_error TEXT,
        body_retryable INTEGER NOT NULL DEFAULT 1,
        body_fetch_started_at TEXT,
        provider_deleted INTEGER NOT NULL DEFAULT 0,
        local_deleted INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        folder TEXT NOT NULL DEFAULT 'inbox' CHECK(folder IN ('inbox', 'archive', 'trash', 'spam')),
        snoozed_until TEXT,
        kind TEXT NOT NULL DEFAULT 'received' CHECK(kind IN ('received', 'draft', 'sent')),
        cc_text TEXT,
        bcc_text TEXT,
        auto_label_id INTEGER REFERENCES labels(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO messages_reliable_sync (
        id, account_id, uid, uid_validity, provider_message_id, message_id, subject, from_name,
        from_address, to_text, received_at, text_body, html_body, snippet, has_attachments,
        is_read, is_starred, size, body_status, body_error, body_retryable, body_fetch_started_at,
        provider_deleted, local_deleted, deleted_at, folder, snoozed_until, kind, cc_text, bcc_text,
        auto_label_id, created_at
      ) SELECT
        id, account_id, uid, uid_validity, provider_message_id, message_id, subject, from_name,
        from_address, to_text, received_at, text_body, html_body, snippet, has_attachments,
        is_read, is_starred, size, body_status, body_error, body_retryable, body_fetch_started_at,
        provider_deleted, local_deleted, deleted_at, folder, snoozed_until, kind, cc_text, bcc_text,
        auto_label_id, created_at
      FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_reliable_sync RENAME TO messages;
    `);
  }
}
