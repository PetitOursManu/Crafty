// Liens de partage : lecture et téléchargement d'un fichier sans compte, par un lien secret, jusqu'à son expiration ou sa
// révocation. Le jeton (32 octets aléatoires) n'est montré qu'une fois ; la base n'en garde que l'empreinte SHA-256.
// Le lien suit la version courante du fichier ; il cesse de fonctionner si le fichier part à la corbeille, si son
// propriétaire est désactivé, ou si l'admin coupe le partage (sharing_enabled).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { extname } from 'node:path';

const hash = (t) => createHash('sha256').update(t).digest('hex');
const EXPIRIES = { '1h': 3_600_000, '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, never: null };
// Aperçu dans la page (types sûrs) ; tout le reste est seulement téléchargeable. Jamais de SVG ni de HTML en ligne.
const INLINE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8' };

export function sharesRoutes(app, { db, files, log, settings, requireUser, json }) {
  const q = {
    file: db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL'),
    insert: db.prepare('INSERT INTO shares (id, user_id, file_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
    ofFile: db.prepare('SELECT * FROM shares WHERE file_id = ? AND user_id = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC'),
    mine: db.prepare(`SELECT s.*, f.name FROM shares s JOIN files f ON f.id = s.file_id WHERE s.user_id = ? AND s.revoked = 0
      AND (s.expires_at IS NULL OR s.expires_at > ?) AND f.deleted_at IS NULL ORDER BY s.created_at DESC`),
    one: db.prepare('SELECT * FROM shares WHERE id = ? AND user_id = ?'),
    revoke: db.prepare('UPDATE shares SET revoked = 1 WHERE id = ?'),
    byToken: db.prepare(`SELECT s.*, f.name, f.size, f.version_id, f.updated_at, u.username FROM shares s
      JOIN files f ON f.id = s.file_id JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked = 0 AND (s.expires_at IS NULL OR s.expires_at > ?) AND f.deleted_at IS NULL AND u.disabled = 0`),
    hit: db.prepare('UPDATE shares SET last_access_at = ?, downloads = downloads + ? WHERE id = ?'),
  };
  const out = (s) => ({ id: s.id, createdAt: s.created_at, expiresAt: s.expires_at, downloads: s.downloads, lastAccessAt: s.last_access_at, ...(s.name ? { fileId: s.file_id, fileName: s.name } : {}) });
  const off = (res) => res.status(403).json({ error: 'Le partage est désactivé par l\'administrateur.' });

  app.post('/api/files/:id/shares', requireUser, json, (req, res) => {
    if (!settings().sharing_enabled) return off(res);
    const f = q.file.get(req.params.id, req.user.id);
    if (!f) return res.status(404).json({ error: 'Fichier introuvable.' });
    const key = req.body?.expires ?? '7d';
    if (!(key in EXPIRIES)) return res.status(400).json({ error: 'Durée invalide.' });
    const token = randomBytes(32).toString('base64url'), id = randomUUID(), now = Date.now();
    const expiresAt = EXPIRIES[key] === null ? null : now + EXPIRIES[key];
    q.insert.run(id, req.user.id, f.id, hash(token), now, expiresAt);
    log.audit(req, 'share.create', f.id, { name: f.name, expires: key });
    res.status(201).json({ id, url: `/s/${token}`, createdAt: now, expiresAt });
  });
  app.get('/api/files/:id/shares', requireUser, (req, res) => {
    const f = q.file.get(req.params.id, req.user.id);
    if (!f) return res.status(404).json({ error: 'Fichier introuvable.' });
    res.set('Cache-Control', 'no-store').json({ enabled: settings().sharing_enabled, shares: q.ofFile.all(f.id, req.user.id, Date.now()).map(out) });
  });
  app.get('/api/shares', requireUser, (req, res) => res.set('Cache-Control', 'no-store').json(q.mine.all(req.user.id, Date.now()).map(out)));
  app.delete('/api/shares/:id', requireUser, (req, res) => {
    const s = q.one.get(req.params.id, req.user.id);
    if (!s) return res.status(404).json({ error: 'Lien introuvable.' });
    q.revoke.run(s.id);
    log.audit(req, 'share.revoke', s.file_id, { share: s.id });
    res.status(204).end();
  });

  // --- Accès public (sans compte) : débit limité par adresse, rien d'indexable, aucun référent transmis. ---
  const hits = new Map();
  const limited = (req) => {
    const now = Date.now(), list = (hits.get(req.ip) || []).filter((t) => now - t < 60_000);
    list.push(now); hits.set(req.ip, list);
    if (hits.size > 10_000) hits.clear();
    return list.length > 120;
  };
  const find = (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    if (limited(req)) { res.status(429).json({ error: 'Trop de requêtes.' }); return null; }
    const s = settings().sharing_enabled && /^[A-Za-z0-9_-]{30,60}$/.test(req.params.token) ? q.byToken.get(hash(req.params.token), Date.now()) : null;
    if (!s) { res.status(404).json({ error: 'Ce lien n\'existe pas ou a expiré.' }); return null; }
    return s;
  };
  app.get('/api/s/:token', (req, res) => {
    const s = find(req, res);
    if (!s) return;
    const ext = extname(s.name).slice(1).toLowerCase();
    q.hit.run(Date.now(), 0, s.id);
    log.audit(req, 'share.access', s.file_id, { share: s.id });
    res.json({ name: s.name, size: s.size, updatedAt: s.updated_at, sharedBy: s.username, expiresAt: s.expires_at,
      preview: INLINE[ext] ? (ext === 'pdf' ? 'pdf' : INLINE[ext].startsWith('image/') ? 'image' : 'text') : null });
  });
  app.get('/api/s/:token/content', (req, res) => {
    const s = find(req, res);
    if (!s) return;
    const ext = extname(s.name).slice(1).toLowerCase();
    const inline = req.query.dl !== '1' && INLINE[ext];
    if (!inline) q.hit.run(Date.now(), 1, s.id);
    res.set({ 'Content-Type': inline || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(s.name)}`,
      // Contenu d'un tiers servi depuis notre origine : jamais de script (le lecteur PDF du navigateur exige qu'on ne mette pas sandbox).
      'Content-Security-Policy': ext === 'pdf' && inline ? "default-src 'none'; frame-ancestors 'self'" : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'" });
    res.sendFile(files.blobPath(s.version_id), (e) => { if (e && !res.headersSent) res.status(404).json({ error: 'Contenu introuvable.' }); });
  });
}
