// Base SQLite : comptes, sessions, réglages, dossiers, fichiers, versions, audit.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_SETTINGS = {
  signup_open: false,            // inscription publique (le premier compte reste toujours possible)
  guest_enabled: false,          // mode invité, sans stockage
  guest_apps: null,              // null = toutes les applications ; sinon liste de slugs
  max_versions: 10,              // versions conservées par fichier (courante comprise)
  default_quota: 1024 ** 3,      // 1 Gio par compte, anciennes versions comprises
  max_file_size: 512 * 1024 ** 2, // limite d'ouverture des applications (512 Mio)
  autosave_seconds: 30,          // délai de la sauvegarde automatique après une modification (0 = désactivée)
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change INTEGER NOT NULL DEFAULT 0,
  all_apps INTEGER NOT NULL DEFAULT 1,
  quota INTEGER,
  theme TEXT NOT NULL DEFAULT 'light',
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS user_apps (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  PRIMARY KEY (user_id, slug)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  guest INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS folders_name ON folders(user_id, IFNULL(parent_id, ''), name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  version_id TEXT,
  last_app TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS files_name ON files(user_id, IFNULL(folder_id, ''), name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  n INTEGER NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  app TEXT,
  created_at INTEGER NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS versions_file ON versions(file_id, n);
CREATE INDEX IF NOT EXISTS versions_user ON versions(user_id);
CREATE TABLE IF NOT EXISTS prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  user_id INTEGER,
  username TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  // Migration : colonne auto (sauvegarde automatique) ajoutée après la première version du schéma.
  if (!db.prepare('PRAGMA table_info(versions)').all().some((c) => c.name === 'auto')) db.exec('ALTER TABLE versions ADD COLUMN auto INTEGER NOT NULL DEFAULT 0');

  const getRow = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setRow = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.settings = () => Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([k, d]) => {
    const r = getRow.get(k);
    return [k, r ? JSON.parse(r.value) : d];
  }));
  db.setSettings = (patch) => {
    for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) setRow.run(k, JSON.stringify(v));
  };
  return db;
}
