import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import Database from "better-sqlite3";
import { MailDatabase } from "../src/database.js";
import type { ParsedMessage } from "../src/types.js";

function message(uid: number, subject: string): ParsedMessage {
  return { uid, providerMessageId: `INBOX:100:${uid}`, messageId: `${uid}@example.test`, subject,
    fromName: "A sender", fromAddress: "sender@example.test", toText: "recipient@example.test",
    receivedAt: "2026-08-01T00:00:00Z", textBody: null, htmlBody: null, snippet: "",
    hasAttachments: false, isRead: false, size: 10, bodyStatus: "not_fetched", bodyError: null };
}

test("FTS follows insert, upsert, deferred body fetch, draft edit and account deletion", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-search-"));
  const file = path.join(dir, "search.db");
  const app = new MailDatabase(file);
  let inspection: Database.Database | undefined;
  t.after(() => {
    inspection?.close();
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const account = app.createAccount({ name: "Search", email: "user@example.test", host: "imap.example.test", port: 993,
    secure: true, username: "user", encryptedPassword: "ciphertext", mailbox: "INBOX", enabled: true });
  const count = (query: string, view: "inbox" | "all" = "inbox") => app.listMessages({ query, view, limit: 100, offset: 0 }).total;
  app.saveMessages(account.id, [message(1, "Original subject")]);
  assert.equal(count("Original"), 1);
  app.saveMessages(account.id, [message(1, "Replacement subject")]);
  assert.equal(count("Original"), 0);
  assert.equal(count("Replacement"), 1);
  const id = (app.listMessages({ limit: 1, offset: 0 }).messages[0] as { id: number }).id;
  app.saveMessageBody(id, { textBody: "Asynchronous attachment invoice", htmlBody: null, snippet: "Asynchronous",
    hasAttachments: false, size: 34, bodyStatus: "fetched", bodyError: null });
  assert.equal(count("attachment"), 1);
  app.saveMessageBody(id, { textBody: "Changed body", htmlBody: null, snippet: "Changed",
    hasAttachments: false, size: 12, bodyStatus: "fetched", bodyError: null });
  assert.equal(count("attachment"), 0);
  assert.equal(count("Changed"), 1);
  app.deleteMessage(id);
  assert.equal(count("Changed", "all"), 0);
  const draft = app.createDraft({ accountId: account.id, to: ["someone@example.test"], cc: [], bcc: [], subject: "Draftword", body: "Unsent" }) as { id: number };
  assert.equal(count("Draftword", "all"), 1);
  app.updateDraft(draft.id, { subject: "Editedword" });
  assert.equal(count("Draftword", "all"), 0);
  assert.equal(count("Editedword", "all"), 1);
  app.deleteAccount(account.id);
  const raw = inspection = new Database(file);
  assert.equal(raw.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'Editedword'").all().length, 0);
  raw.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)");
});

test("30,000 existing messages retain substring search results and use the trigram index", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-search-volume-"));
  const file = path.join(dir, "search.db");
  const raw = new Database(file);
  raw.exec(fs.readFileSync(new URL("./fixtures/v0.5.1-schema.sql", import.meta.url), "utf8"));
  raw.exec(`INSERT INTO accounts(id,sync_id,sync_updated_at,name,email,host,port,username,encrypted_password)
    VALUES(1,'sync-id','2026-08-01T00:00:00.000Z','Search','user@example.test','imap.example.test',993,'user','ciphertext');`);
  const insert = raw.prepare(`INSERT INTO messages(account_id,uid,subject,from_name,from_address,to_text,snippet,text_body,received_at)
    VALUES(1,?,?,?,?,?,?,?,'2026-08-01T00:00:00Z')`);
  const columns = ["subject", "from_name", "from_address", "to_text", "snippet", "text_body"];
  raw.transaction(() => {
    for (let n = 1; n <= 30_000; n++) {
      const fields = Array.from({ length: 6 }, (_, i) => `Ordinary field ${i} message ${n}`);
      if (n % 1000 === 0) fields[(n / 1000) % 6] = "Attachment invoice 工作报告 CAFÉ café foo_bar 100% mail@example.test OR \"quoted\"";
      insert.run(n, ...fields);
    }
  })();
  raw.close();
  const started = performance.now();
  const app = new MailDatabase(file);
  let inspection: Database.Database | undefined;
  t.after(() => {
    inspection?.close();
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  t.diagnostic(`Upgrade and FTS backfill: ${(performance.now() - started).toFixed(1)} ms for 30,000 messages`);
  const check = inspection = new Database(file);
  const where = columns.map(c => `${c} LIKE @q`).join(" OR ");
  const old = check.prepare(`SELECT id FROM messages WHERE ${where} ORDER BY received_at DESC,id DESC`);
  for (const query of ["invoice", "tach", "工作", "工作报", "报", "CAFÉ", "café", "CAFé", "foo_bar", "100%", "mail@example", "OR", '"quoted"', "%", "_", "absent-value"]) {
    const expected = old.all({ q: `%${query}%` }).map(r => (r as { id: number }).id);
    const result = app.listMessages({ query, limit: 30_000, offset: 0 });
    assert.deepEqual(result.messages.map(r => (r as { id: number }).id), expected, query);
    assert.equal(result.total, expected.length, query);
  }
  const plan = check.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM messages_fts WHERE subject LIKE ?").all("%invoice%");
  assert.match(JSON.stringify(plan), /VIRTUAL TABLE INDEX .*L0/);
  check.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)");
  const oldCount = check.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`);
  const indexedCount = check.prepare(`SELECT COUNT(*) AS n FROM messages WHERE id IN (${columns.map(c => `SELECT rowid FROM messages_fts WHERE ${c} LIKE @q`).join(" UNION ")})`);
  const sample = (statement: Database.Statement) => {
    const start = performance.now();
    for (let i = 0; i < 20; i++) assert.deepEqual(statement.get({ q: "%invoice%" }), { n: 30 });
    return (performance.now() - start) / 20;
  };
  t.diagnostic(`Mean selective count, 20 runs: LIKE ${sample(oldCount).toFixed(2)} ms; FTS ${sample(indexedCount).toFixed(2)} ms. Timing is diagnostic, not a CI threshold.`);
});
