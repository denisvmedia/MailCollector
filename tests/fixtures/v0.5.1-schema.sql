-- Schema created by MailDatabase from v0.5.1 (a0d635a08e36a9a44561ea38b3505b6688defd46).
-- src/database.ts is unchanged between this tag and v0.14.1. No user data.
CREATE TABLE accounts (
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
CREATE TABLE app_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
CREATE TABLE app_users (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        email TEXT NOT NULL,
        normalized_email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
CREATE TABLE labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        built_in INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
CREATE TABLE mail_jobs (
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
CREATE TABLE mail_operations (
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
CREATE TABLE message_labels (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
        PRIMARY KEY (message_id, label_id)
      );
CREATE TABLE messages (
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
      , auto_label_id INTEGER REFERENCES labels(id));
CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
CREATE UNIQUE INDEX accounts_sync_id_idx ON accounts(sync_id);
CREATE INDEX app_sessions_expires_at_idx ON app_sessions(expires_at);
CREATE INDEX mail_jobs_ready_idx ON mail_jobs(status, run_after, priority, id);
CREATE INDEX mail_operations_ready_idx ON mail_operations(status, next_retry_at, id);
CREATE INDEX message_labels_label_id_idx ON message_labels(label_id, message_id);
CREATE INDEX messages_account_id_idx ON messages(account_id);
CREATE INDEX messages_account_uid_idx ON messages(account_id, uid_validity, uid);
CREATE INDEX messages_folder_idx ON messages(folder, received_at DESC);
CREATE INDEX messages_kind_idx ON messages(kind, received_at DESC);
CREATE UNIQUE INDEX messages_provider_id_idx ON messages(account_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX messages_received_at_idx ON messages(received_at DESC);
CREATE INDEX messages_snoozed_until_idx ON messages(snoozed_until);
