CREATE VIRTUAL TABLE messages_fts USING fts5(subject, from_name, from_address, to_text, snippet, text_body, content='messages', content_rowid='id', tokenize='trigram');
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, from_name, from_address, to_text, snippet, text_body) VALUES(new.id, new.subject, new.from_name, new.from_address, new.to_text, new.snippet, new.text_body);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, to_text, snippet, text_body) VALUES('delete', old.id, old.subject, old.from_name, old.from_address, old.to_text, old.snippet, old.text_body);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF id, subject, from_name, from_address, to_text, snippet, text_body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, to_text, snippet, text_body) VALUES('delete', old.id, old.subject, old.from_name, old.from_address, old.to_text, old.snippet, old.text_body);
  INSERT INTO messages_fts(rowid, subject, from_name, from_address, to_text, snippet, text_body) VALUES(new.id, new.subject, new.from_name, new.from_address, new.to_text, new.snippet, new.text_body);
END;
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
