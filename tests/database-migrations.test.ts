import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { MailDatabase } from "../src/database.js";
import { decryptSecret, encryptSecret } from "../src/crypto.js";

const schema = fs.readFileSync(new URL("./fixtures/v0.5.1-schema.sql", import.meta.url), "utf8");
const ptah = process.env.PTAH_BIN || "ptah";
const accountSQL = `INSERT INTO accounts(id,sync_id,sync_updated_at,name,email,host,port,username,encrypted_password,uid_validity)
  VALUES(7,'existing-sync-id','2026-08-01T00:00:00.000Z','Fixture','user@example.test','imap.example.test',993,'user',?, '100')`;

function location(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-migration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Exercise URL escaping as well as the default ASCII deployment path.
  return { dir, file: path.join(dir, "mail # 工作.db") };
}

function snapshot(db: Database.Database, tables: string[]) {
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

for (const legacyIdentity of [false, true]) {
test(`upgrades ${legacyIdentity ? "legacy UID identity" : "v0.5.1"} without changing data or old revisions and runs once`, t => {
  const { file } = location(t);
  const key = crypto.randomBytes(32);
  const secret = encryptSecret("preserved refresh token", key);
  let raw = new Database(file);
  raw.exec(legacyIdentity ? schema.replace("auto_label_id INTEGER REFERENCES labels(id));", "auto_label_id INTEGER REFERENCES labels(id), UNIQUE(account_id, uid));") : schema);
  raw.prepare(accountSQL).run(secret);
  raw.exec(`
    INSERT INTO messages(id,account_id,uid,uid_validity,provider_message_id,subject,received_at,text_body,is_starred)
      VALUES(11,7,9,'100','INBOX:100:9','Preexisting invoice','2026-08-01T00:00:00Z','Searchable archive',1);
    INSERT INTO labels(id,name,built_in) VALUES(4,'Custom',0), (5,'工作',1), (6,'个人',1), (7,'订阅',1);
    INSERT INTO message_labels(message_id,label_id) VALUES(11,4);
    INSERT INTO mail_jobs(id,account_id,type,priority,run_after) VALUES(13,7,'incremental',5,'2026-08-01T00:00:00Z');
    INSERT INTO mail_operations(id,account_id,message_id,uid,uid_validity,operation,next_retry_at)
      VALUES(17,7,11,9,'100','read','2026-08-01T00:00:00Z');
    INSERT INTO app_users(id,email,normalized_email,password_hash) VALUES(1,'admin@example.test','admin@example.test','existing-password-hash');
    INSERT INTO app_sessions(token_hash,user_id,expires_at) VALUES('existing-session',1,'2099-01-01T00:00:00Z');
    INSERT INTO schema_migrations(version,name,applied_at) VALUES(1,'reliable_mail_sync','2026-08-01'),(2,'uidvalidity_message_identity','2026-08-02');
  `);
  const tables = ["accounts", "messages", "labels", "message_labels", "mail_jobs", "mail_operations", "app_users", "app_sessions"];
  const before = snapshot(raw, tables);
  const history = raw.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  raw.close();

  let app = new MailDatabase(file);
  assert.equal(app.listMessages({ query: "invoice", limit: 10, offset: 0 }).total, 1);
  app.close();
  raw = new Database(file);
  assert.deepEqual(snapshot(raw, tables), before);
  assert.deepEqual(raw.prepare("SELECT * FROM schema_migrations WHERE version < 3 ORDER BY version").all(), history);
  assert.equal(decryptSecret((raw.prepare("SELECT encrypted_password FROM accounts WHERE id=7").get() as { encrypted_password: string }).encrypted_password, key), "preserved refresh token");
  assert.deepEqual(raw.pragma("foreign_key_check"), []);
  const revisions = snapshot(raw, ["schema_migrations", "ptah_schema_migrations"]);
  // Abort any attempted repeat of the old startup UPDATE or an FTS rebuild.
  raw.exec(`CREATE TRIGGER forbid_repeated_adoption BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT,'adoption ran twice'); END;`);
  const ftsData = raw.prepare("SELECT * FROM messages_fts_data ORDER BY id").all();
  raw.close();
  app = new MailDatabase(file);
  app.close();
  raw = new Database(file);
  assert.deepEqual(snapshot(raw, ["schema_migrations", "ptah_schema_migrations"]), revisions);
  assert.deepEqual(raw.prepare("SELECT * FROM messages_fts_data ORDER BY id").all(), ftsData);
  raw.close();
});
}

test("a failed legacy adoption rolls back schema changes and its marker", t => {
  const { file } = location(t);
  let raw = new Database(file);
  raw.exec(schema);
  raw.prepare(accountSQL).run("unchanged ciphertext");
  raw.exec("ALTER TABLE accounts DROP COLUMN sync_updated_at; CREATE TRIGGER fail_adoption BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT,'injected legacy failure'); END;");
  const before = raw.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
  raw.close();
  assert.throws(() => new MailDatabase(file), /injected legacy failure/);
  raw = new Database(file);
  assert.deepEqual(raw.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(), before);
  assert.equal(raw.prepare("SELECT * FROM schema_migrations").all().length, 0);
  raw.exec("DROP TRIGGER fail_adoption");
  raw.close();
  new MailDatabase(file).close();
});

test("Ptah rolls back an unsuccessful SQL migration, including FTS objects", t => {
  const { dir, file } = location(t);
  new MailDatabase(file).close();
  const migrations = path.join(dir, "migrations");
  fs.cpSync(new URL("../migrations/", import.meta.url), migrations, { recursive: true });
  fs.writeFileSync(path.join(migrations, "0000000005_failure.up.sql"), `
    CREATE VIRTUAL TABLE rollback_fts USING fts5(body);
    INSERT INTO rollback_fts(body) VALUES('must roll back');
    INSERT INTO missing_table VALUES(1);
  `);
  fs.writeFileSync(path.join(migrations, "0000000005_failure.down.sql"), "DROP TABLE rollback_fts;\n");
  execFileSync(ptah, ["migrations", "hash", "--dir", migrations]);
  const failed = spawnSync(ptah, ["migrations", "up", "--db-url", pathToFileURL(file).href.replace(/^file:/, "sqlite:"), "--migrations-dir", migrations, "--migrations-table", "ptah_schema_migrations", "--tx-mode", "file", "--verify-sum"], { encoding: "utf8" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /missing_table/);
  const raw = new Database(file);
  assert.deepEqual(raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'rollback_fts%'").all(), []);
  assert.deepEqual(raw.prepare("SELECT version FROM ptah_schema_migrations WHERE state = 'applied' ORDER BY version").all(), [{ version: 4 }]);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n, 3);
  raw.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)");
  raw.close();
});
