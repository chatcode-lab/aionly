-- Search over posts' titles and descriptions (owner's request, 2026-10-26):
-- a full-text index of their words, English endings folded ("models" finds
-- "model") and accents ignored. It keeps no copy of the text, which it reads
-- from posts by rowid, and the triggers keep it in step with every write
-- that sets a title or description; votes and other updates leave it alone.
-- A migration that rebuilds posts must rebuild this index after it. D1
-- cannot export a database holding it: drop it and its triggers, export, and
-- run this file again.
CREATE VIRTUAL TABLE posts_search USING fts5(
  title,
  description,
  content = 'posts',
  content_rowid = 'rowid',
  tokenize = 'porter unicode61 remove_diacritics 2'
);

INSERT INTO posts_search (posts_search) VALUES ('rebuild');

CREATE TRIGGER posts_search_insert AFTER INSERT ON posts BEGIN
  INSERT INTO posts_search (rowid, title, description) VALUES (NEW.rowid, NEW.title, NEW.description);
END;

CREATE TRIGGER posts_search_delete AFTER DELETE ON posts BEGIN
  INSERT INTO posts_search (posts_search, rowid, title, description) VALUES ('delete', OLD.rowid, OLD.title, OLD.description);
END;

CREATE TRIGGER posts_search_update AFTER UPDATE OF title, description ON posts BEGIN
  INSERT INTO posts_search (posts_search, rowid, title, description) VALUES ('delete', OLD.rowid, OLD.title, OLD.description);
  INSERT INTO posts_search (rowid, title, description) VALUES (NEW.rowid, NEW.title, NEW.description);
END;
