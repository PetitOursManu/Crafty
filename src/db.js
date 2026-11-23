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
  trash_days: 30,                // durée dans la corbeille avant effacement définitif (0 = pas de corbeille)
  sharing_enabled: true,         // liens de partage publics vers un fichier
  sso_create_accounts: true,     // SSO Dashy : première connexion d'une identité Dashy inconnue = nouveau compte
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
CREATE TABLE IF NOT EXISTS app_data (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, app)
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
  // Migrations : colonne auto (sauvegarde automatique) ; corbeille (deleted_at, trash_root) et miniatures (thumb_version),
  // avec des noms uniques seulement hors de la corbeille (index partiels) ; favoris, récents, partages.
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  for (const t of ['files', 'folders']) {
    if (!cols(t).includes('deleted_at')) db.exec(`ALTER TABLE ${t} ADD COLUMN deleted_at INTEGER; ALTER TABLE ${t} ADD COLUMN trash_root INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols('files').includes('thumb_version')) db.exec('ALTER TABLE files ADD COLUMN thumb_version TEXT');
  // Lot de suppression : ce qui est parti ensemble revient ensemble (une date ne suffit pas : deux suppressions dans la même ms).
  for (const t of ['files', 'folders']) if (!cols(t).includes('trash_batch')) db.exec(`ALTER TABLE ${t} ADD COLUMN trash_batch TEXT`);
  db.exec(`DROP INDEX IF EXISTS folders_name; DROP INDEX IF EXISTS files_name;
    CREATE UNIQUE INDEX IF NOT EXISTS folders_live_name ON folders(user_id, IFNULL(parent_id, ''), name COLLATE NOCASE) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS files_live_name ON files(user_id, IFNULL(folder_id, ''), name COLLATE NOCASE) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS files_trash ON files(user_id, deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS folders_trash ON folders(user_id, deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS favorites (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
      item_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, kind, item_id));
    CREATE TABLE IF NOT EXISTS recents (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE, app TEXT, opened_at INTEGER NOT NULL, PRIMARY KEY (user_id, file_id));
    CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      expires_at INTEGER, downloads INTEGER NOT NULL DEFAULT 0, last_access_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS shares_file ON shares(file_id);`);
  // Double authentification (TOTP, secret chiffré par CRAFTY_SECRET) et compte lié à une identité Dashy (SSO).
  if (!cols('users').includes('totp_enabled')) db.exec(`ALTER TABLE users ADD COLUMN totp_secret TEXT;
    ALTER TABLE users ADD COLUMN totp_pending TEXT; ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0; ALTER TABLE users ADD COLUMN dashy_sub TEXT;`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_dashy ON users(dashy_sub) WHERE dashy_sub IS NOT NULL;
    CREATE TABLE IF NOT EXISTS recovery_codes (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL, used_at INTEGER, PRIMARY KEY (user_id, code_hash));
    CREATE TABLE IF NOT EXISTS sso_jti (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);`);
  // Compte relié à Kosmy Board (OpenID Connect) : identifiant `sub` du Board, jamais l'e-mail.
  if (!cols('users').includes('kosmy_sub')) db.exec('ALTER TABLE users ADD COLUMN kosmy_sub TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_kosmy ON users(kosmy_sub) WHERE kosmy_sub IS NOT NULL');
  // Adresse e-mail (facultative, en minuscules) : donnée par Kosmy Board pour un compte qu'il gère, ou saisie par l'admin ;
  // sert seulement à relier un compte existant quand le Board donne l'accès à cette adresse (PUT, jamais à la connexion).
  if (!cols('users').includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
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
