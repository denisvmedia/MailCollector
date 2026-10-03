import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { classifyMail, type AutoCategory, type ClassifiableMessage } from "./mail-classifier.js";
import { inferProvider } from "./providers.js";
import { migrateDatabase } from "./database-migrations.js";
import type {
  BackfillResult,
  DraftInput,
  LocalMessageContent,
  MailAccount,
  MessageActions,
  MessageKind,
  MessageLabel,
  MessageView,
  MailOperation,
  MailOperationType,
  ParsedMessage,
  PublicMailAccount,
  SyncResult
} from "./types.js";

type AccountRow = {
  id: number;
  sync_id: string;
  sync_updated_at: string;
  name: string;
  email: string;
  host: string;
  port: number;
  secure: number;
  username: string;
  encrypted_password: string;
  mailbox: string;
  provider: "gmail" | "microsoft" | "imap";
  enabled: number;
  uid_validity: string | null;
  last_uid: number;
  last_sync_at: string | null;
  last_successful_sync_at: string | null;
  last_reconcile_at: string | null;
  last_event_at: string | null;
  last_error: string | null;
  sync_error_count: number;
  sync_state: MailAccount["syncState"];
  next_sync_at: string | null;
  backfill_cursor: number | null;
  backfill_status: MailAccount["backfillStatus"];
  created_at: string;
};

export type MailJobType = "initial" | "incremental" | "reconcile" | "backfill" | "operation";

export type MailJob = {
  id: number;
  accountId: number;
  type: MailJobType;
  priority: number;
  reason: string;
  attempts: number;
  maxAttempts: number;
};

function normalizeBodyStatus(status: string): string {
  if (status === "complete") return "fetched";
  if (status === "too_large" || status === "parse_error") return "failed";
  return status;
}

type AppUserRow = {
  id: number;
  email: string;
  normalized_email: string;
  password_hash: string;
  created_at: string;
};

export type AppUser = {
  id: number;
  email: string;
  normalizedEmail: string;
  passwordHash: string;
  createdAt: string;
};

export class MailDatabase {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    migrateDatabase(databasePath);
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
  }

  close(): void {
    this.db.close();
  }

  hasAppUser(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM app_users WHERE id = 1").get());
  }

  getAppUserByEmail(normalizedEmail: string): AppUser | null {
    const row = this.db.prepare("SELECT * FROM app_users WHERE normalized_email = ?").get(normalizedEmail) as AppUserRow | undefined;
    return row ? this.mapAppUser(row) : null;
  }

  createAppUser(email: string, normalizedEmail: string, passwordHash: string): AppUser {
    this.db.prepare(`
      INSERT INTO app_users (id, email, normalized_email, password_hash)
      VALUES (1, ?, ?, ?)
    `).run(email, normalizedEmail, passwordHash);
    return this.getAppUserByEmail(normalizedEmail)!;
  }

  createAppSession(tokenHash: string, userId: number, expiresAt: string): void {
    this.db.prepare(`
      INSERT INTO app_sessions (token_hash, user_id, expires_at)
      VALUES (?, ?, ?)
    `).run(tokenHash, userId, expiresAt);
  }

  getAppUserForSession(tokenHash: string, now = new Date().toISOString()): AppUser | null {
    this.db.prepare("DELETE FROM app_sessions WHERE expires_at <= ?").run(now);
    const row = this.db.prepare(`
      SELECT app_users.*
      FROM app_sessions
      JOIN app_users ON app_users.id = app_sessions.user_id
      WHERE app_sessions.token_hash = ? AND app_sessions.expires_at > ?
    `).get(tokenHash, now) as AppUserRow | undefined;
    return row ? this.mapAppUser(row) : null;
  }

  deleteAppSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM app_sessions WHERE token_hash = ?").run(tokenHash);
  }

  createAccount(input: Omit<MailAccount,
    "id" | "syncId" | "syncUpdatedAt" | "provider" | "uidValidity" | "lastUid" | "lastSyncAt" | "lastSuccessfulSyncAt" |
    "lastReconcileAt" | "lastEventAt" | "lastError" | "syncErrorCount" | "syncState" |
    "nextSyncAt" | "backfillCursor" | "backfillStatus" | "createdAt"
  > & { syncId?: string; syncUpdatedAt?: string; provider?: MailAccount["provider"] }): MailAccount {
    const syncId = input.syncId ?? crypto.randomUUID();
    const syncUpdatedAt = input.syncUpdatedAt ?? new Date().toISOString();
    this.assertSyncTimestamp(syncUpdatedAt);
    const result = this.db.prepare(`
      INSERT INTO accounts (sync_id, sync_updated_at, name, email, host, port, secure, username, encrypted_password, mailbox, provider, enabled)
      VALUES (@syncId, @syncUpdatedAt, @name, @email, @host, @port, @secure, @username, @encryptedPassword, @mailbox, @provider, @enabled)
    `).run({ ...input, syncId, syncUpdatedAt, provider: input.provider ?? inferProvider(input.host), secure: Number(input.secure), enabled: Number(input.enabled) });
    return this.getAccount(Number(result.lastInsertRowid))!;
  }

  getAccount(id: number): MailAccount | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
    return row ? this.mapAccount(row) : null;
  }

  listAccounts(): MailAccount[] {
    return (this.db.prepare("SELECT * FROM accounts ORDER BY created_at DESC, id DESC").all() as AccountRow[])
      .map((row) => this.mapAccount(row));
  }

  listPublicAccounts(syncingIds: Set<number>): PublicMailAccount[] {
    const counts = new Map((this.db.prepare(`
      SELECT account_id AS accountId, COUNT(*) AS messageCount,
        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unreadCount
      FROM messages
      WHERE kind = 'received' AND provider_deleted = 0 AND local_deleted = 0
      GROUP BY account_id
    `).all() as Array<{ accountId: number; messageCount: number; unreadCount: number }>).map((row) => [row.accountId, row]));
    return this.listAccounts().map(({ encryptedPassword: _password, ...account }) => ({
      ...account,
      status: !account.enabled ? "disabled"
        : syncingIds.has(account.id) || account.syncState === "syncing" || account.syncState === "initial_sync" ? "syncing"
        : account.syncState === "backfilling" ? "backfilling"
        : account.syncState === "reauth_required" ? "reauth_required"
        : account.syncState === "degraded" ? "degraded"
        : account.syncState === "error" ? "error"
        : "ready",
      messageCount: counts.get(account.id)?.messageCount ?? 0,
      unreadCount: counts.get(account.id)?.unreadCount ?? 0
    }));
  }

  deleteAccount(id: number): boolean {
    return this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes > 0;
  }

  setAccountEnabled(id: number, enabled: boolean): void {
    this.db.prepare(`
      UPDATE accounts SET enabled = ?, sync_updated_at = ?,
        lease_owner = CASE WHEN ? = 0 THEN NULL ELSE lease_owner END,
        lease_expires_at = CASE WHEN ? = 0 THEN NULL ELSE lease_expires_at END
      WHERE id = ?
    `).run(Number(enabled), new Date().toISOString(), Number(enabled), Number(enabled), id);
  }

  markSyncError(id: number, error: string): void {
    this.db.prepare(`
      UPDATE accounts
      SET last_sync_at = ?, last_error = ?, sync_error_count = sync_error_count + 1,
        sync_state = CASE WHEN sync_error_count >= 4 THEN 'error' ELSE 'degraded' END
      WHERE id = ?
    `).run(new Date().toISOString(), error.slice(0, 1000), id);
  }

  markReauthRequired(id: number, error: string): void {
    this.db.prepare(`
      UPDATE accounts SET last_sync_at = ?, last_error = ?, sync_error_count = sync_error_count + 1,
        sync_state = 'reauth_required' WHERE id = ?
    `).run(new Date().toISOString(), error.slice(0, 1000), id);
  }

  saveMessages(accountId: number, messages: ParsedMessage[]): number {
    const insert = this.messageInsertStatement();
    const transaction = this.db.transaction((items: ParsedMessage[]) => {
      let inserted = 0;
      for (const message of items) {
        const providerMessageId = message.providerMessageId ?? `legacy:${message.uid}`;
        const existing = this.db.prepare("SELECT id FROM messages WHERE account_id = ? AND provider_message_id = ?").get(accountId, providerMessageId) as { id: number } | undefined;
        const result = insert.run({
          accountId,
          ...message,
          uidValidity: providerMessageId.split(":").at(-2) ?? "legacy",
          providerMessageId,
          bodyStatus: normalizeBodyStatus(message.bodyStatus),
          hasAttachments: Number(message.hasAttachments),
          isRead: Number(message.isRead)
        });
        if (!existing && result.changes) {
          inserted += 1;
          this.applyAutoClassification(Number(result.lastInsertRowid), message);
        }
      }
      return inserted;
    });
    return transaction(messages);
  }

  commitSync(accountId: number, result: SyncResult, leaseOwner?: string): { inserted: number; mailboxReset: boolean } {
    const insert = this.messageInsertStatement();
    const transaction = this.db.transaction(() => {
      const account = this.getAccount(accountId);
      if (!account) throw new Error("邮箱不存在");
      this.assertAccountLease(accountId, leaseOwner);
      const mailboxReset = account.uidValidity !== null && account.uidValidity !== result.uidValidity;
      if (mailboxReset) {
        this.db.prepare(`
          UPDATE messages SET provider_deleted = 1, deleted_at = ?
          WHERE account_id = ? AND kind = 'received' AND provider_deleted = 0
        `).run(new Date().toISOString(), accountId);
        this.db.prepare(`
          UPDATE mail_operations SET status = 'failed', last_error = 'UIDVALIDITY 已变化，旧 UID 操作已取消',
            lease_owner = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE account_id = ? AND uid_validity <> ? AND status IN ('pending', 'processing')
        `).run(accountId, result.uidValidity);
      }

      let inserted = 0;
      for (const message of result.messages) {
        const providerMessageId = message.providerMessageId ?? `${account.mailbox}:${result.uidValidity}:${message.uid}`;
        const existing = this.db.prepare("SELECT id FROM messages WHERE account_id = ? AND provider_message_id = ?").get(accountId, providerMessageId) as { id: number } | undefined;
        const insertedMessage = insert.run({ accountId, ...message, uidValidity: result.uidValidity, providerMessageId, bodyStatus: normalizeBodyStatus(message.bodyStatus), hasAttachments: Number(message.hasAttachments), isRead: Number(message.isRead) });
        if (!existing && insertedMessage.changes) {
          inserted += 1;
          this.applyAutoClassification(Number(insertedMessage.lastInsertRowid), message);
        }
      }
      const updateRemoteState = this.db.prepare(`
        UPDATE messages SET
          is_read = CASE WHEN EXISTS (
            SELECT 1 FROM mail_operations o WHERE o.message_id = messages.id
              AND o.status IN ('pending', 'processing') AND o.operation IN ('mark_read', 'mark_unread')
          ) THEN is_read ELSE @isRead END,
          is_starred = CASE WHEN EXISTS (
            SELECT 1 FROM mail_operations o WHERE o.message_id = messages.id
              AND o.status IN ('pending', 'processing') AND o.operation IN ('star', 'unstar')
          ) THEN is_starred ELSE @isStarred END
        WHERE account_id = @accountId AND uid_validity = @uidValidity AND uid = @uid AND kind = 'received'
      `);
      const remoteStates = result.remoteStates ?? ((result as SyncResult & { readStates?: Array<{ uid: number; isRead: boolean }> }).readStates ?? []).map((state) => ({ ...state, isStarred: false }));
      for (const state of remoteStates) {
        updateRemoteState.run({ isRead: Number(state.isRead), isStarred: Number(state.isStarred), accountId, uidValidity: result.uidValidity, uid: state.uid });
      }
      if (result.reconcileWindow) {
        const present = new Set(result.reconcileWindow.presentUids);
        const local = this.db.prepare(`
          SELECT id, uid FROM messages
          WHERE account_id = ? AND uid_validity = ? AND kind = 'received' AND provider_deleted = 0 AND uid >= ?
        `).all(accountId, result.uidValidity, result.reconcileWindow.minUid) as Array<{ id: number; uid: number }>;
        const tombstone = this.db.prepare("UPDATE messages SET provider_deleted = 1, deleted_at = ? WHERE id = ?");
        const deletedAt = new Date().toISOString();
        for (const message of local) {
          if (!present.has(message.uid)) tombstone.run(deletedAt, message.id);
        }
      }
      const completedAt = new Date().toISOString();
      this.db.prepare(`
        UPDATE accounts
        SET uid_validity = ?,
          last_uid = CASE WHEN uid_validity IS NULL OR uid_validity <> ? THEN ? ELSE MAX(last_uid, ?) END,
          last_sync_at = ?, last_successful_sync_at = ?, last_error = NULL,
          sync_error_count = 0, sync_state = 'idle'
        WHERE id = ?
      `).run(result.uidValidity, result.uidValidity, result.lastUid, result.lastUid, completedAt, completedAt, accountId);
      if (result.backfillCursor !== undefined) {
        this.db.prepare(`
          UPDATE accounts SET backfill_cursor = ?, backfill_status = ? WHERE id = ?
        `).run(result.backfillCursor, result.backfillCursor === null ? "complete" : "pending", accountId);
      }
      return { inserted, mailboxReset };
    });
    return transaction();
  }

  private messageInsertStatement(): Database.Statement {
    return this.db.prepare(`
      INSERT INTO messages (
        account_id, uid, uid_validity, provider_message_id, message_id, subject, from_name, from_address, to_text,
        received_at, text_body, html_body, snippet, has_attachments, is_read, size,
        body_status, body_error, provider_deleted, deleted_at
      ) VALUES (
        @accountId, @uid, @uidValidity, @providerMessageId, @messageId, @subject, @fromName, @fromAddress, @toText,
        @receivedAt, @textBody, @htmlBody, @snippet, @hasAttachments, @isRead, @size,
        @bodyStatus, @bodyError, 0, NULL
      )
      ON CONFLICT(account_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO UPDATE SET
        uid = excluded.uid,
        uid_validity = excluded.uid_validity,
        provider_message_id = excluded.provider_message_id,
        message_id = excluded.message_id,
        subject = excluded.subject,
        from_name = excluded.from_name,
        from_address = excluded.from_address,
        to_text = excluded.to_text,
        received_at = excluded.received_at,
        snippet = CASE WHEN messages.body_status = 'fetched' THEN messages.snippet ELSE excluded.snippet END,
        has_attachments = excluded.has_attachments,
        size = excluded.size,
        text_body = CASE WHEN excluded.body_status = 'fetched' THEN excluded.text_body ELSE messages.text_body END,
        html_body = CASE WHEN excluded.body_status = 'fetched' THEN excluded.html_body ELSE messages.html_body END,
        body_status = CASE WHEN messages.body_status = 'fetched' AND excluded.body_status = 'not_fetched' THEN messages.body_status ELSE excluded.body_status END,
        body_error = CASE WHEN excluded.body_status = 'fetched' THEN NULL ELSE messages.body_error END,
        provider_deleted = 0,
        deleted_at = NULL
    `);
  }

  listMessages(input: {
    view?: MessageView;
    label?: string;
    accountId?: number;
    accountIds?: number[];
    query?: string;
    readState?: "read" | "unread";
    starred?: boolean;
    limit: number;
    offset: number;
  }): { messages: unknown[]; total: number } {
    const conditions: string[] = ["m.provider_deleted = 0", "m.local_deleted = 0"];
    const parameters: Record<string, unknown> = { limit: input.limit, offset: input.offset, now: new Date().toISOString() };
    switch (input.view ?? "inbox") {
      case "inbox":
        conditions.push("m.kind = 'received'", "m.folder = 'inbox'", "(m.snoozed_until IS NULL OR m.snoozed_until <= @now)");
        break;
      case "archive":
      case "trash":
      case "spam":
        conditions.push("m.kind = 'received'", "m.folder = @view");
        parameters.view = input.view;
        break;
      case "snoozed":
        conditions.push("m.kind = 'received'", "m.snoozed_until > @now");
        break;
      case "sent":
        conditions.push("m.kind = 'sent'");
        break;
      case "drafts":
        conditions.push("m.kind = 'draft'");
        break;
      case "all":
        break;
    }
    if (input.accountId) {
      conditions.push("m.account_id = @accountId");
      parameters.accountId = input.accountId;
    }
    if (input.accountIds?.length) {
      const placeholders = input.accountIds.map((id, index) => {
        const key = `accountId${index}`;
        parameters[key] = id;
        return `@${key}`;
      });
      conditions.push(`m.account_id IN (${placeholders.join(", ")})`);
    }
    if (input.query) {
      // Trigram LIKE preserves substring/wildcard semantics. SQLite cannot use
      // its trigram index without a run of at least three literal characters.
      if (/[^%_]{3}/u.test(input.query)) {
        conditions.push(`m.id IN (
          SELECT rowid FROM messages_fts WHERE subject LIKE @query
          UNION SELECT rowid FROM messages_fts WHERE from_name LIKE @query
          UNION SELECT rowid FROM messages_fts WHERE from_address LIKE @query
          UNION SELECT rowid FROM messages_fts WHERE to_text LIKE @query
          UNION SELECT rowid FROM messages_fts WHERE snippet LIKE @query
          UNION SELECT rowid FROM messages_fts WHERE text_body LIKE @query
        )`);
      } else {
        conditions.push("(m.subject LIKE @query OR m.from_name LIKE @query OR m.from_address LIKE @query OR m.to_text LIKE @query OR m.snippet LIKE @query OR m.text_body LIKE @query)");
      }
      parameters.query = `%${input.query}%`;
    }
    if (input.readState) conditions.push(`m.is_read = ${input.readState === "read" ? 1 : 0}`);
    if (input.starred !== undefined) conditions.push(`m.is_starred = ${input.starred ? 1 : 0}`);
    if (input.label) {
      if (/^\d+$/.test(input.label)) {
        conditions.push("EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id = @labelId)");
        parameters.labelId = Number(input.label);
      } else {
        conditions.push("EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = m.id AND l.name = @labelName COLLATE NOCASE)");
        parameters.labelName = input.label;
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT m.id, m.account_id AS accountId, a.name AS accountName, a.email AS accountEmail,
        m.subject, m.from_name AS fromName, m.from_address AS fromAddress, m.to_text AS toText,
        m.received_at AS receivedAt, m.snippet, m.has_attachments AS hasAttachments,
        m.is_read AS isRead, m.is_starred AS isStarred, m.size,
        m.body_status AS bodyStatus, m.folder, m.snoozed_until AS snoozedUntil, m.kind
      FROM messages m JOIN accounts a ON a.id = m.account_id
      ${where}
      ORDER BY m.received_at DESC, m.id DESC
      LIMIT @limit OFFSET @offset
    `).all(parameters) as Array<Record<string, unknown> & { id: number }>;
    const labels = this.labelsForMessageIds(rows.map((row) => row.id));
    const messages = rows.map((row) => ({
      ...row,
      hasAttachments: Boolean(row.hasAttachments),
      isRead: Boolean(row.isRead),
      isStarred: Boolean(row.isStarred),
      labels: labels.get(row.id) ?? []
    }));
    const total = (this.db.prepare(`SELECT COUNT(*) AS total FROM messages m JOIN accounts a ON a.id = m.account_id ${where}`).get(parameters) as { total: number }).total;
    return { messages, total };
  }

  getMessage(id: number): unknown | null {
    const row = this.db.prepare(`
      SELECT m.id, m.account_id AS accountId, a.name AS accountName, a.email AS accountEmail,
        m.message_id AS messageId, m.subject, m.from_name AS fromName,
        m.from_address AS fromAddress, m.to_text AS toText, m.received_at AS receivedAt,
        m.cc_text AS ccText, m.bcc_text AS bccText,
        m.text_body AS textBody, m.html_body AS htmlBody, m.snippet,
        m.has_attachments AS hasAttachments, m.is_read AS isRead, m.is_starred AS isStarred, m.size, m.body_status AS bodyStatus,
        m.body_error AS bodyError, m.folder, m.snoozed_until AS snoozedUntil, m.kind
      FROM messages m JOIN accounts a ON a.id = m.account_id
      WHERE m.id = ? AND m.provider_deleted = 0 AND m.local_deleted = 0
    `).get(id) as any;
    if (!row) return null;
    return {
      ...row,
      hasAttachments: Boolean(row.hasAttachments),
      isRead: Boolean(row.isRead),
      isStarred: Boolean(row.isStarred),
      labels: this.labelsForMessageIds([id]).get(id) ?? [],
      to: this.addressList(row.toText),
      cc: this.addressList(row.ccText),
      bcc: this.addressList(row.bccText)
    };
  }

  setMessageRead(id: number, isRead: boolean): boolean {
    return this.updateMessages([id], { isRead }).updated > 0;
  }

  setMessageStarred(id: number, isStarred: boolean): boolean {
    return this.updateMessages([id], { isStarred }).updated > 0;
  }

  updateMessages(ids: number[], actions: MessageActions): { updated: number; missingIds: number[] } {
    const uniqueIds = [...new Set(ids)];
    const transaction = this.db.transaction(() => {
      const placeholders = uniqueIds.map(() => "?").join(", ");
      const existingMessages = uniqueIds.length
        ? this.db.prepare(`SELECT id, account_id AS accountId, uid, uid_validity AS uidValidity, kind FROM messages WHERE id IN (${placeholders}) AND provider_deleted = 0 AND local_deleted = 0`).all(...uniqueIds) as Array<{ id: number; accountId: number; uid: number; uidValidity: string; kind: MessageKind }>
        : [];
      const existingIds = existingMessages.map((row) => row.id);
      const existingSet = new Set(existingIds);
      const missingIds = uniqueIds.filter((id) => !existingSet.has(id));

      if (actions.labels !== undefined) this.assertLabelsExist(actions.labels);
      const assignments: string[] = [];
      const values: unknown[] = [];
      if (actions.isRead !== undefined) {
        assignments.push("is_read = ?");
        values.push(Number(actions.isRead));
      }
      if (actions.isStarred !== undefined) {
        assignments.push("is_starred = ?");
        values.push(Number(actions.isStarred));
      }
      if (actions.folder !== undefined) {
        assignments.push("folder = ?");
        values.push(actions.folder);
      }
      if (actions.snoozedUntil !== undefined) {
        assignments.push("snoozed_until = ?");
        values.push(actions.snoozedUntil);
      }
      if (assignments.length && existingIds.length) {
        const existingPlaceholders = existingIds.map(() => "?").join(", ");
        this.db.prepare(`UPDATE messages SET ${assignments.join(", ")} WHERE id IN (${existingPlaceholders})`).run(...values, ...existingIds);
      }
      if (actions.labels !== undefined && existingIds.length) {
        const existingPlaceholders = existingIds.map(() => "?").join(", ");
        this.db.prepare(`UPDATE messages SET auto_label_id = NULL WHERE id IN (${existingPlaceholders})`).run(...existingIds);
        this.db.prepare(`DELETE FROM message_labels WHERE message_id IN (${existingPlaceholders})`).run(...existingIds);
        const insert = this.db.prepare("INSERT INTO message_labels (message_id, label_id) VALUES (?, ?)");
        for (const messageId of existingIds) {
          for (const labelId of [...new Set(actions.labels)]) insert.run(messageId, labelId);
        }
      }
      for (const message of existingMessages) {
        if (message.kind !== "received") continue;
        if (actions.isRead !== undefined) this.enqueueOperationInternal(message, actions.isRead ? "mark_read" : "mark_unread");
        if (actions.isStarred !== undefined) this.enqueueOperationInternal(message, actions.isStarred ? "star" : "unstar");
      }
      return { updated: existingIds.length, missingIds };
    });
    return transaction();
  }

  deleteMessage(id: number): boolean {
    return this.db.prepare(`
      UPDATE messages SET local_deleted = 1, deleted_at = ?
      WHERE id = ? AND local_deleted = 0
    `).run(new Date().toISOString(), id).changes > 0;
  }

  getMessageProviderRef(id: number): { id: number; accountId: number; uid: number; uidValidity: string; size: number; bodyStatus: string; bodyRetryable: boolean } | null {
    const row = this.db.prepare(`
      SELECT id, account_id AS accountId, uid, uid_validity AS uidValidity, size,
        body_status AS bodyStatus, body_retryable AS bodyRetryable
      FROM messages WHERE id = ? AND kind = 'received' AND provider_deleted = 0 AND local_deleted = 0
    `).get(id) as { id: number; accountId: number; uid: number; uidValidity: string; size: number; bodyStatus: string; bodyRetryable: number } | undefined;
    return row ? { ...row, bodyRetryable: Boolean(row.bodyRetryable) } : null;
  }

  listPendingBodyFetchIds(perAccount: number, limit: number, maxSize: number): number[] {
    return (this.db.prepare(`
      SELECT id FROM (
        SELECT id, received_at,
          ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY received_at DESC) AS rn
        FROM messages
        WHERE kind = 'received' AND provider_deleted = 0 AND local_deleted = 0
          AND body_status = 'not_fetched' AND size <= @maxSize
      )
      WHERE rn <= @perAccount
      ORDER BY received_at DESC
      LIMIT @limit
    `).all({ perAccount, limit, maxSize }) as Array<{ id: number }>).map((row) => row.id);
  }

  markBodyFetching(id: number): boolean {
    return this.db.prepare(`
      UPDATE messages SET body_status = 'fetching', body_error = NULL, body_retryable = 1, body_fetch_started_at = ?
      WHERE id = ? AND body_status IN ('not_fetched', 'failed') AND provider_deleted = 0 AND local_deleted = 0
    `).run(new Date().toISOString(), id).changes > 0;
  }

  reclaimStaleBodyFetches(staleBefore: string): void {
    this.db.prepare(`
      UPDATE messages SET body_status = 'failed', body_error = '正文获取任务中断，可重试',
        body_retryable = 1, body_fetch_started_at = NULL
      WHERE body_status = 'fetching' AND (body_fetch_started_at IS NULL OR body_fetch_started_at <= ?)
    `).run(staleBefore);
  }

  saveMessageBody(id: number, body: Pick<ParsedMessage, "textBody" | "htmlBody" | "snippet" | "hasAttachments" | "size" | "bodyStatus" | "bodyError">, leaseOwner?: string): void {
    const result = this.db.prepare(`
      UPDATE messages SET text_body = @textBody, html_body = @htmlBody, snippet = @snippet,
        has_attachments = @hasAttachments, size = @size, body_status = @bodyStatus, body_error = @bodyError,
        body_retryable = @bodyRetryable, body_fetch_started_at = NULL
      WHERE id = @id AND provider_deleted = 0 AND local_deleted = 0
        AND (@leaseOwner IS NULL OR EXISTS (
          SELECT 1 FROM accounts WHERE accounts.id = messages.account_id AND accounts.lease_owner = @leaseOwner
        ))
    `).run({ id, ...body, leaseOwner: leaseOwner ?? null, hasAttachments: Number(body.hasAttachments), bodyRetryable: Number(body.bodyStatus !== "failed") });
    if (leaseOwner && !result.changes) throw new Error("账号同步租约已失效");
  }

  markBodyFailed(id: number, error: string, retryable = true, leaseOwner?: string): void {
    this.db.prepare(`
      UPDATE messages SET body_status = 'failed', body_error = ?, body_retryable = ?, body_fetch_started_at = NULL
      WHERE id = ? AND (? IS NULL OR EXISTS (
        SELECT 1 FROM accounts WHERE accounts.id = messages.account_id AND accounts.lease_owner = ?
      ))
    `).run(error.slice(0, 1000), Number(retryable), id, leaseOwner ?? null, leaseOwner ?? null);
  }

  commitBackfill(accountId: number, result: BackfillResult, leaseOwner?: string): { inserted: number; complete: boolean } {
    const insert = this.messageInsertStatement();
    const transaction = this.db.transaction(() => {
      this.assertAccountLease(accountId, leaseOwner);
      let inserted = 0;
      for (const message of result.messages) {
        const account = this.getAccount(accountId);
        if (!account?.uidValidity) throw new Error("邮箱同步游标不存在");
        const providerMessageId = message.providerMessageId ?? `${account.mailbox}:${account.uidValidity}:${message.uid}`;
        const existing = this.db.prepare("SELECT id FROM messages WHERE account_id = ? AND provider_message_id = ?").get(accountId, providerMessageId) as { id: number } | undefined;
        const stored = insert.run({ accountId, ...message, uidValidity: account.uidValidity, providerMessageId, bodyStatus: normalizeBodyStatus(message.bodyStatus), hasAttachments: Number(message.hasAttachments), isRead: Number(message.isRead) });
        if (!existing && stored.changes) {
          inserted += 1;
          this.applyAutoClassification(Number(stored.lastInsertRowid), message);
        }
      }
      const updateRemoteState = this.db.prepare(`
        UPDATE messages SET
          is_read = CASE WHEN EXISTS (
            SELECT 1 FROM mail_operations o WHERE o.message_id = messages.id
              AND o.status IN ('pending', 'processing') AND o.operation IN ('mark_read', 'mark_unread')
          ) THEN is_read ELSE @isRead END,
          is_starred = CASE WHEN EXISTS (
            SELECT 1 FROM mail_operations o WHERE o.message_id = messages.id
              AND o.status IN ('pending', 'processing') AND o.operation IN ('star', 'unstar')
          ) THEN is_starred ELSE @isStarred END
        WHERE account_id = @accountId AND uid_validity = @uidValidity AND uid = @uid AND kind = 'received'
      `);
      const account = this.getAccount(accountId);
      for (const state of result.remoteStates ?? []) updateRemoteState.run({ isRead: Number(state.isRead), isStarred: Number(state.isStarred), accountId, uidValidity: account?.uidValidity, uid: state.uid });
      this.db.prepare(`
        UPDATE accounts SET backfill_cursor = ?, backfill_status = ?, sync_state = ?, last_error = NULL
        WHERE id = ?
      `).run(result.nextCursor, result.complete ? "complete" : "pending", result.complete ? "idle" : "backfilling", accountId);
      return { inserted, complete: result.complete };
    });
    return transaction();
  }

  acquireAccountLease(accountId: number, owner: string, leaseMs: number): boolean {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
    return this.db.prepare(`
      UPDATE accounts SET lease_owner = ?, lease_expires_at = ?
      WHERE id = ? AND (lease_owner IS NULL OR lease_expires_at <= ? OR lease_owner = ?)
    `).run(owner, expiresAt, accountId, now.toISOString(), owner).changes > 0;
  }

  renewAccountLease(accountId: number, owner: string, leaseMs: number): boolean {
    return this.db.prepare("UPDATE accounts SET lease_expires_at = ? WHERE id = ? AND lease_owner = ?")
      .run(new Date(Date.now() + leaseMs).toISOString(), accountId, owner).changes > 0;
  }

  releaseAccountLease(accountId: number, owner: string): void {
    this.db.prepare("UPDATE accounts SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?")
      .run(accountId, owner);
  }

  hasAccountLease(accountId: number, owner: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM accounts WHERE id = ? AND enabled = 1 AND lease_owner = ? AND lease_expires_at > ?")
      .get(accountId, owner, new Date().toISOString()));
  }

  markSyncStarted(accountId: number, state: MailAccount["syncState"]): void {
    this.db.prepare("UPDATE accounts SET sync_state = ?, last_sync_at = ? WHERE id = ?")
      .run(state, new Date().toISOString(), accountId);
  }

  markReconciled(accountId: number, nextSyncAt: string): void {
    this.db.prepare("UPDATE accounts SET last_reconcile_at = ?, next_sync_at = ? WHERE id = ?")
      .run(new Date().toISOString(), nextSyncAt, accountId);
  }

  recordSyncEvent(accountId: number): void {
    this.db.prepare("UPDATE accounts SET last_event_at = ? WHERE id = ?").run(new Date().toISOString(), accountId);
  }

  setNextSyncAt(accountId: number, nextSyncAt: string): void {
    this.db.prepare("UPDATE accounts SET next_sync_at = ? WHERE id = ?").run(nextSyncAt, accountId);
  }

  enqueueJob(accountId: number, type: MailJobType, priority: number, reason: string, runAfter = new Date(), maxAttempts = 5, preserveExistingRunAfter = false, reactivateFailed = false): void {
    this.db.prepare(`
      INSERT INTO mail_jobs (account_id, type, priority, reason, run_after, max_attempts)
      VALUES (@accountId, @type, @priority, @reason, @runAfter, @maxAttempts)
      ON CONFLICT(account_id, type) DO UPDATE SET
        priority = MIN(mail_jobs.priority, excluded.priority),
        reason = excluded.reason,
        run_after = CASE
          WHEN mail_jobs.status = 'processing' THEN excluded.run_after
          WHEN mail_jobs.status = 'failed' AND @reactivateFailed = 1 THEN excluded.run_after
          WHEN @preserveExistingRunAfter = 1 AND mail_jobs.status = 'pending' THEN mail_jobs.run_after
          ELSE MIN(mail_jobs.run_after, excluded.run_after)
        END,
        max_attempts = excluded.max_attempts,
        attempts = CASE WHEN mail_jobs.status = 'failed' AND (@preserveExistingRunAfter = 0 OR @reactivateFailed = 1) THEN 0 ELSE mail_jobs.attempts END,
        rerun_requested = CASE WHEN mail_jobs.status = 'processing' THEN 1 ELSE mail_jobs.rerun_requested END,
        status = CASE
          WHEN mail_jobs.status = 'processing' THEN mail_jobs.status
          WHEN mail_jobs.status = 'failed' AND @preserveExistingRunAfter = 1 AND @reactivateFailed = 0 THEN mail_jobs.status
          ELSE 'pending'
        END,
        updated_at = CURRENT_TIMESTAMP
    `).run({
      accountId,
      type,
      priority,
      reason: reason.slice(0, 200),
      runAfter: runAfter.toISOString(),
      maxAttempts,
      preserveExistingRunAfter: Number(preserveExistingRunAfter),
      reactivateFailed: Number(reactivateFailed)
    });
  }

  claimNextJob(owner: string, leaseMs: number): MailJob | null {
    const transaction = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE mail_jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
        WHERE status = 'processing' AND lease_expires_at <= ?
      `).run(now);
      const row = this.db.prepare(`
        SELECT j.id, j.account_id AS accountId, j.type, j.priority, j.reason, j.attempts, j.max_attempts AS maxAttempts
        FROM mail_jobs j JOIN accounts a ON a.id = j.account_id
        WHERE j.status = 'pending' AND j.run_after <= ? AND a.enabled = 1
          AND NOT EXISTS (SELECT 1 FROM mail_jobs active WHERE active.account_id = j.account_id AND active.status = 'processing')
        ORDER BY j.priority ASC, j.run_after ASC, j.id ASC LIMIT 1
      `).get(now) as MailJob | undefined;
      if (!row) return null;
      const claimed = this.db.prepare(`
        UPDATE mail_jobs SET status = 'processing', attempts = attempts + 1, lease_owner = ?,
          lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'
      `).run(owner, new Date(Date.now() + leaseMs).toISOString(), row.id);
      return claimed.changes ? { ...row, attempts: row.attempts + 1 } : null;
    });
    return transaction();
  }

  renewJobLease(id: number, owner: string, leaseMs: number): boolean {
    return this.db.prepare(`
      UPDATE mail_jobs SET lease_expires_at = ? WHERE id = ? AND status = 'processing' AND lease_owner = ?
    `).run(new Date(Date.now() + leaseMs).toISOString(), id, owner).changes > 0;
  }

  completeJob(id: number, owner: string): void {
    const row = this.db.prepare("SELECT rerun_requested AS rerunRequested FROM mail_jobs WHERE id = ? AND status = 'processing' AND lease_owner = ?").get(id, owner) as { rerunRequested: number } | undefined;
    if (!row) return;
    if (row.rerunRequested) {
      this.db.prepare(`
        UPDATE mail_jobs SET status = 'pending', attempts = 0, run_after = ?, rerun_requested = 0,
          lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lease_owner = ?
      `).run(new Date().toISOString(), id, owner);
    } else {
      this.db.prepare("DELETE FROM mail_jobs WHERE id = ? AND lease_owner = ?").run(id, owner);
    }
  }

  failJob(id: number, owner: string, error: string, retryAt: Date | null): void {
    if (retryAt) {
      this.db.prepare(`
        UPDATE mail_jobs SET status = 'pending', run_after = ?, lease_owner = NULL, lease_expires_at = NULL,
          last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'processing' AND lease_owner = ?
      `).run(retryAt.toISOString(), error.slice(0, 1000), id, owner);
    } else {
      this.db.prepare(`
        UPDATE mail_jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
          last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'processing' AND lease_owner = ?
      `).run(error.slice(0, 1000), id, owner);
    }
  }

  claimNextOperation(accountId: number, owner: string, leaseMs: number): MailOperation | null {
    const transaction = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE mail_operations SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
        WHERE status = 'processing' AND lease_expires_at <= ?
      `).run(now);
      const row = this.db.prepare(`
        SELECT id, account_id AS accountId, message_id AS messageId, uid, uid_validity AS uidValidity, operation, payload,
          attempts, max_attempts AS maxAttempts
        FROM mail_operations
        WHERE account_id = ? AND status = 'pending' AND next_retry_at <= ?
        ORDER BY id ASC LIMIT 1
      `).get(accountId, now) as (Omit<MailOperation, "payload"> & { payload: string }) | undefined;
      if (!row) return null;
      const claimed = this.db.prepare(`
        UPDATE mail_operations SET status = 'processing', attempts = attempts + 1, lease_owner = ?,
          lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'
      `).run(owner, new Date(Date.now() + leaseMs).toISOString(), row.id);
      return claimed.changes ? { ...row, attempts: row.attempts + 1, payload: JSON.parse(row.payload) as Record<string, unknown> } : null;
    });
    return transaction();
  }

  renewOperationLease(id: number, owner: string, leaseMs: number): boolean {
    return this.db.prepare(`
      UPDATE mail_operations SET lease_expires_at = ? WHERE id = ? AND status = 'processing' AND lease_owner = ?
    `).run(new Date(Date.now() + leaseMs).toISOString(), id, owner).changes > 0;
  }

  completeOperation(id: number, owner: string): boolean {
    return this.db.prepare(`
      UPDATE mail_operations SET status = 'success', lease_owner = NULL, lease_expires_at = NULL,
        last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'processing' AND lease_owner = ?
        AND EXISTS (
          SELECT 1 FROM accounts WHERE accounts.id = mail_operations.account_id
            AND accounts.enabled = 1 AND accounts.lease_owner = ? AND accounts.lease_expires_at > ?
        )
    `).run(id, owner, owner, new Date().toISOString()).changes > 0;
  }

  failOperation(id: number, owner: string, error: string, retryAt: Date | null): void {
    this.db.prepare(`
      UPDATE mail_operations SET status = ?, next_retry_at = COALESCE(?, next_retry_at),
        lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'processing' AND lease_owner = ?
    `).run(retryAt ? "pending" : "failed", retryAt?.toISOString() ?? null, error.slice(0, 1000), id, owner);
  }

  hasPendingOperations(accountId: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM mail_operations WHERE account_id = ? AND status IN ('pending', 'processing') LIMIT 1").get(accountId));
  }

  enqueueCorrectiveOperation(messageId: number, family: "read" | "star"): void {
    const transaction = this.db.transaction(() => {
      const message = this.db.prepare(`
        SELECT id, account_id AS accountId, uid, uid_validity AS uidValidity, is_read AS isRead, is_starred AS isStarred
        FROM messages WHERE id = ? AND provider_deleted = 0 AND local_deleted = 0 AND kind = 'received'
      `).get(messageId) as { id: number; accountId: number; uid: number; uidValidity: string; isRead: number; isStarred: number } | undefined;
      if (!message) return;
      const operation: MailOperationType = family === "read"
        ? (message.isRead ? "mark_read" : "mark_unread")
        : (message.isStarred ? "star" : "unstar");
      this.enqueueOperationInternal(message, operation);
    });
    transaction();
  }

  countJobs(accountId: number, type?: MailJobType): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM mail_jobs WHERE account_id = ? ${type ? "AND type = ?" : ""}
    `).get(...(type ? [accountId, type] : [accountId])) as { count: number };
    return row.count;
  }

  getOperationState(messageId: number): { status: string; attempts: number; lastError: string | null } | null {
    return this.db.prepare(`
      SELECT status, attempts, last_error AS lastError FROM mail_operations
      WHERE message_id = ? ORDER BY id DESC LIMIT 1
    `).get(messageId) as { status: string; attempts: number; lastError: string | null } | undefined ?? null;
  }

  getMessageDeletionState(id: number): { providerDeleted: boolean; localDeleted: boolean; deletedAt: string | null } | null {
    const row = this.db.prepare(`
      SELECT provider_deleted AS providerDeleted, local_deleted AS localDeleted, deleted_at AS deletedAt
      FROM messages WHERE id = ?
    `).get(id) as { providerDeleted: number; localDeleted: number; deletedAt: string | null } | undefined;
    return row ? { providerDeleted: Boolean(row.providerDeleted), localDeleted: Boolean(row.localDeleted), deletedAt: row.deletedAt } : null;
  }

  private enqueueOperationInternal(message: { id: number; accountId: number; uid: number; uidValidity: string }, operation: MailOperationType): void {
    const family = operation === "mark_read" || operation === "mark_unread" ? ["mark_read", "mark_unread"] : ["star", "unstar"];
    this.db.prepare(`
      DELETE FROM mail_operations WHERE message_id = ? AND status = 'pending' AND operation IN (?, ?)
    `).run(message.id, ...family);
    this.db.prepare(`
      INSERT INTO mail_operations (account_id, message_id, uid, uid_validity, operation, next_retry_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(message.accountId, message.id, message.uid, message.uidValidity, operation, new Date().toISOString());
    this.enqueueJob(message.accountId, "operation", 0, "user_operation");
  }

  listLabels(): Array<MessageLabel & { messageCount: number }> {
    return (this.db.prepare(`
      SELECT l.id, l.name, l.built_in AS builtIn, COUNT(ml.message_id) AS messageCount
      FROM labels l LEFT JOIN message_labels ml ON ml.label_id = l.id
      GROUP BY l.id
      ORDER BY l.built_in DESC, l.name COLLATE NOCASE
    `).all() as Array<{ id: number; name: string; builtIn: number; messageCount: number }>).map((row) => ({
      ...row,
      builtIn: Boolean(row.builtIn)
    }));
  }

  autoClassifyMessages(accountId?: number): { classified: number; changed: number; unchanged: number; unclassified: number; byLabel: Record<AutoCategory, number> } {
    const rows = this.db.prepare(`
      SELECT id, subject, from_name AS fromName, from_address AS fromAddress,
        to_text AS toText, text_body AS textBody, snippet
      FROM messages
      WHERE kind = 'received' ${accountId ? "AND account_id = ?" : ""}
    `).all(...(accountId ? [accountId] : [])) as Array<ClassifiableMessage & { id: number }>;
    const result = { classified: 0, changed: 0, unchanged: 0, unclassified: 0, byLabel: { 工作: 0, 个人: 0, 订阅: 0 } };
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        const status = this.applyAutoClassification(row.id, row);
        if (status.category) {
          result.classified += 1;
          result.byLabel[status.category] += 1;
        } else {
          result.unclassified += 1;
        }
        if (status.changed) result.changed += 1; else result.unchanged += 1;
      }
    });
    transaction();
    return result;
  }

  createLabel(name: string): MessageLabel {
    try {
      const result = this.db.prepare("INSERT INTO labels (name) VALUES (?)").run(name);
      return { id: Number(result.lastInsertRowid), name, builtIn: false };
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) throw new Error("标签已存在");
      throw error;
    }
  }

  deleteLabel(id: number): "deleted" | "missing" | "protected" {
    const label = this.db.prepare("SELECT built_in AS builtIn FROM labels WHERE id = ?").get(id) as { builtIn: number } | undefined;
    if (!label) return "missing";
    if (label.builtIn) return "protected";
    this.db.prepare("DELETE FROM labels WHERE id = ?").run(id);
    return "deleted";
  }

  createDraft(input: DraftInput): unknown {
    return this.createLocalMessage(input.accountId, "draft", input);
  }

  updateDraft(id: number, input: Partial<LocalMessageContent>): unknown | null {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (input.to !== undefined) { assignments.push("to_text = ?"); values.push(input.to.join(", ")); }
    if (input.cc !== undefined) { assignments.push("cc_text = ?"); values.push(input.cc.join(", ")); }
    if (input.bcc !== undefined) { assignments.push("bcc_text = ?"); values.push(input.bcc.join(", ")); }
    if (input.subject !== undefined) { assignments.push("subject = ?"); values.push(input.subject); }
    if (input.body !== undefined) {
      assignments.push("text_body = ?", "snippet = ?", "size = ?");
      values.push(input.body, this.snippet(input.body), Buffer.byteLength(input.body));
    }
    assignments.push("received_at = ?");
    values.push(new Date().toISOString());
    const result = this.db.prepare(`UPDATE messages SET ${assignments.join(", ")} WHERE id = ? AND kind = 'draft'`).run(...values, id);
    return result.changes ? this.getMessage(id) : null;
  }

  createSentMessage(input: DraftInput, messageId: string | null, sentAt = new Date().toISOString()): unknown {
    return this.createLocalMessage(input.accountId, "sent", input, messageId, sentAt);
  }

  convertDraftToSent(id: number, messageId: string | null, sentAt = new Date().toISOString()): unknown | null {
    const result = this.db.prepare(`
      UPDATE messages
      SET kind = 'sent', folder = 'archive', message_id = ?, received_at = ?, is_read = 1, snoozed_until = NULL
      WHERE id = ? AND kind = 'draft'
    `).run(messageId, sentAt, id);
    return result.changes ? this.getMessage(id) : null;
  }

  getDraft(id: number): (LocalMessageContent & { id: number; accountId: number }) | null {
    const row = this.db.prepare(`
      SELECT id, account_id AS accountId, to_text AS toText, cc_text AS ccText,
        bcc_text AS bccText, subject, text_body AS body
      FROM messages WHERE id = ? AND kind = 'draft'
    `).get(id) as { id: number; accountId: number; toText: string | null; ccText: string | null; bccText: string | null; subject: string; body: string | null } | undefined;
    return row ? {
      id: row.id,
      accountId: row.accountId,
      to: this.addressList(row.toText),
      cc: this.addressList(row.ccText),
      bcc: this.addressList(row.bccText),
      subject: row.subject,
      body: row.body ?? ""
    } : null;
  }

  private createLocalMessage(accountId: number, kind: Exclude<MessageKind, "received">, input: LocalMessageContent, messageId: string | null = null, receivedAt = new Date().toISOString()): unknown {
    const transaction = this.db.transaction(() => {
      const account = this.getAccount(accountId);
      if (!account) throw new Error("邮箱不存在");
      const minimum = this.db.prepare("SELECT MIN(uid) AS uid FROM messages WHERE account_id = ?").get(accountId) as { uid: number | null };
      const uid = Math.min(-1, (minimum.uid ?? 0) - 1);
      const result = this.db.prepare(`
        INSERT INTO messages (
          account_id, uid, message_id, subject, from_name, from_address, to_text, cc_text, bcc_text,
          received_at, text_body, snippet, is_read, size, folder, kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'archive', ?)
      `).run(
        accountId, uid, messageId, input.subject, account.name, account.email,
        input.to.join(", "), input.cc.join(", "), input.bcc.join(", "), receivedAt,
        input.body, this.snippet(input.body), Buffer.byteLength(input.body), kind
      );
      return Number(result.lastInsertRowid);
    });
    return this.getMessage(transaction());
  }

  private applyAutoClassification(messageId: number, message: ClassifiableMessage): { category: AutoCategory | null; changed: boolean } {
    const category = classifyMail(message);
    const stored = this.db.prepare("SELECT auto_label_id AS autoLabelId FROM messages WHERE id = ?").get(messageId) as { autoLabelId: number | null } | undefined;
    if (!stored) return { category, changed: false };
    const label = category
      ? this.db.prepare("SELECT id FROM labels WHERE name = ? COLLATE NOCASE").get(category) as { id: number } | undefined
      : undefined;
    const nextLabelId = label?.id ?? null;
    if (stored.autoLabelId === nextLabelId) return { category, changed: false };
    if (stored.autoLabelId) this.db.prepare("DELETE FROM message_labels WHERE message_id = ? AND label_id = ?").run(messageId, stored.autoLabelId);
    if (nextLabelId) this.db.prepare("INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)").run(messageId, nextLabelId);
    this.db.prepare("UPDATE messages SET auto_label_id = ? WHERE id = ?").run(nextLabelId, messageId);
    return { category, changed: true };
  }

  private assertLabelsExist(labelIds: number[]): void {
    const uniqueIds = [...new Set(labelIds)];
    if (!uniqueIds.length) return;
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const count = (this.db.prepare(`SELECT COUNT(*) AS count FROM labels WHERE id IN (${placeholders})`).get(...uniqueIds) as { count: number }).count;
    if (count !== uniqueIds.length) throw new Error("标签不存在");
  }

  private assertAccountLease(accountId: number, leaseOwner?: string): void {
    if (!leaseOwner) return;
    if (!this.hasAccountLease(accountId, leaseOwner)) throw new Error("账号同步租约已失效");
  }

  private labelsForMessageIds(messageIds: number[]): Map<number, MessageLabel[]> {
    const result = new Map<number, MessageLabel[]>();
    if (!messageIds.length) return result;
    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT ml.message_id AS messageId, l.id, l.name, l.built_in AS builtIn
      FROM message_labels ml JOIN labels l ON l.id = ml.label_id
      WHERE ml.message_id IN (${placeholders})
      ORDER BY l.built_in DESC, l.name COLLATE NOCASE
    `).all(...messageIds) as Array<{ messageId: number; id: number; name: string; builtIn: number }>;
    for (const row of rows) {
      const labels = result.get(row.messageId) ?? [];
      labels.push({ id: row.id, name: row.name, builtIn: Boolean(row.builtIn) });
      result.set(row.messageId, labels);
    }
    return result;
  }

  private addressList(value: string | null): string[] {
    return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  }

  private snippet(body: string): string {
    return body.replace(/\s+/g, " ").trim().slice(0, 240);
  }

  private assertSyncTimestamp(value: string): void {
    if (!Number.isFinite(Date.parse(value))) throw new Error("同步时间无效");
  }

  private mapAccount(row: AccountRow): MailAccount {
    return {
      id: row.id,
      syncId: row.sync_id,
      syncUpdatedAt: row.sync_updated_at,
      name: row.name,
      email: row.email,
      host: row.host,
      port: row.port,
      secure: Boolean(row.secure),
      username: row.username,
      encryptedPassword: row.encrypted_password,
      mailbox: row.mailbox,
      provider: row.provider,
      enabled: Boolean(row.enabled),
      uidValidity: row.uid_validity,
      lastUid: row.last_uid,
      lastSyncAt: row.last_sync_at,
      lastSuccessfulSyncAt: row.last_successful_sync_at,
      lastReconcileAt: row.last_reconcile_at,
      lastEventAt: row.last_event_at,
      lastError: row.last_error,
      syncErrorCount: row.sync_error_count,
      syncState: row.sync_state,
      nextSyncAt: row.next_sync_at,
      backfillCursor: row.backfill_cursor,
      backfillStatus: row.backfill_status,
      createdAt: row.created_at
    };
  }

  private mapAppUser(row: AppUserRow): AppUser {
    return {
      id: row.id,
      email: row.email,
      normalizedEmail: row.normalized_email,
      passwordHash: row.password_hash,
      createdAt: row.created_at
    };
  }
}
