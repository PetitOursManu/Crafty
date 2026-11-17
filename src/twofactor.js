// Double authentification par code à usage unique (TOTP) et codes de secours.
// Connexion en deux étapes : mot de passe juste → ticket (5 min, 5 essais, en mémoire) → code → session.
// Le secret est chiffré en base avec CRAFTY_SECRET (src/secrets.js) ; les codes de secours sont stockés hachés (SHA-256)
// et ne servent qu'une fois. Les comptes liés à Dashy sans mot de passe passent par la double authentification de Dashy.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import qrcode from 'qrcode-generator';
import { verifyPassword, rateLimiter, tokenHash } from './auth.js';
import { makeSealer } from './secrets.js';
import { newSecret, verifyCode, otpauthUri } from './totp.js';

const TICKET_TTL = 5 * 60_000, TICKET_TRIES = 5, RECOVERY_COUNT = 10;
const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const hashCode = (c) => createHash('sha256').update(String(c).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');
const newRecoveryCode = () => {
  const s = Array.from({ length: 10 }, () => RC_ALPHABET[randomInt(RC_ALPHABET.length)]).join('');
  return `${s.slice(0, 5)}-${s.slice(5)}`;
};

export function createTwoFactor({ db, log, auth, secret = process.env.CRAFTY_SECRET || '' }) {
  const { seal, open, encrypted } = makeSealer(secret, 'crafty-totp');
  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    setPending: db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?'),
    enable: db.prepare('UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_enabled = 1, totp_last_step = ? WHERE id = ?'),
    disable: db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, totp_last_step = 0 WHERE id = ?'),
    lastStep: db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?'),
    clearCodes: db.prepare('DELETE FROM recovery_codes WHERE user_id = ?'),
    addCode: db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)'),
    useCode: db.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL'),
    codesLeft: db.prepare('SELECT COUNT(*) n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL'),
  };
  const tickets = new Map(); // empreinte du ticket → { userId, exp, tries }
  const codeLimit = rateLimiter(10, 60_000); // codes essayés par minute et par IP
  const hasPassword = (u) => String(u.pass_hash).startsWith('scrypt$');

  function newCodes(userId) {
    const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
    db.transaction(() => { q.clearCodes.run(userId); for (const c of codes) q.addCode.run(userId, hashCode(c)); })();
    return codes;
  }
  // Code TOTP (ou, si allowRecovery, code de secours) du compte : 'totp' | 'recovery' | null.
  function checkCode(u, code, { allowRecovery = true } = {}) {
    const s = open(u.totp_secret);
    if (s) {
      const step = verifyCode(s, code, { lastStep: u.totp_last_step });
      if (step !== null) { q.lastStep.run(step, u.id); return 'totp'; }
    }
    if (allowRecovery && String(code ?? '').replace(/[^a-z0-9]/gi, '').length === 10 && q.useCode.run(Date.now(), u.id, hashCode(code)).changes === 1) return 'recovery';
    return null;
  }

  function startTicket(u) {
    const now = Date.now();
    if (tickets.size > 5000) for (const [k, v] of tickets) if (v.exp < now) tickets.delete(k);
    const token = randomBytes(32).toString('base64url');
    tickets.set(tokenHash(token), { userId: u.id, exp: now + TICKET_TTL, tries: 0 });
    return token;
  }

  function routes(app, { json, requireUser }) {
    // Deuxième étape de la connexion.
    app.post('/api/auth/2fa', json, (req, res) => {
      if (!codeLimit(`2fa:${req.ip}`)) return res.status(429).json({ error: 'Trop de tentatives, réessayez dans une minute.' });
      const key = tokenHash(String(req.body?.ticket ?? '')), t = tickets.get(key);
      if (!t || t.exp < Date.now()) { tickets.delete(key); return res.status(401).json({ error: 'Délai dépassé : reconnectez-vous.', expired: true }); }
      const u = q.user.get(t.userId);
      if (!u || u.disabled || !u.totp_enabled) { tickets.delete(key); return res.status(401).json({ error: 'Délai dépassé : reconnectez-vous.', expired: true }); }
      if (u.locked_until > Date.now()) { tickets.delete(key); return res.status(423).json({ error: 'Compte verrouillé pendant 15 minutes après trop d\'échecs.' }); }
      const how = checkCode(u, req.body?.code);
      if (!how) {
        auth.secondFactorFail(req, u);
        if (++t.tries >= TICKET_TRIES) { tickets.delete(key); return res.status(401).json({ error: 'Trop de codes faux : reconnectez-vous.', expired: true }); }
        return res.status(401).json({ error: 'Code incorrect.' });
      }
      tickets.delete(key);
      auth.secondFactorOk(req, u);
      auth.openSession(req, res, { userId: u.id });
      req.user = { id: u.id, username: u.username };
      log.audit(req, 'auth.login', null, how === 'recovery' ? { secondFactor: 'recovery', left: q.codesLeft.get(u.id).n } : { secondFactor: 'totp' });
      res.json({ ok: true, mustChange: !!u.must_change, recoveryLeft: how === 'recovery' ? q.codesLeft.get(u.id).n : undefined });
    });

    app.get('/api/me/2fa', requireUser, (req, res) => {
      const u = q.user.get(req.user.id);
      res.set('Cache-Control', 'no-store').json({ enabled: !!u.totp_enabled, recoveryLeft: u.totp_enabled ? q.codesLeft.get(u.id).n : 0,
        available: hasPassword(u), encrypted });
    });

    // Mise en place : mot de passe redemandé ; le secret reste « en attente » jusqu'au premier code juste.
    app.post('/api/me/2fa/setup', requireUser, json, async (req, res) => {
      const u = q.user.get(req.user.id);
      if (!hasPassword(u)) return res.status(400).json({ error: 'Compte relié à Dashy : la double authentification se règle dans Dashy.' });
      if (u.totp_enabled) return res.status(409).json({ error: 'La double authentification est déjà active.' });
      if (!(await verifyPassword(String(req.body?.password ?? ''), u.pass_hash))) {
        log.auth('AUTH_FAIL', { ip: req.ip, user: u.username, reason: 'totp_setup' });
        return res.status(400).json({ error: 'Mot de passe actuel incorrect.' });
      }
      const s = newSecret();
      q.setPending.run(seal(s), u.id);
      res.set('Cache-Control', 'no-store').json({ secret: s, uri: otpauthUri({ secret: s, account: u.username }) });
    });
    // QR code du secret en attente (image SVG de même origine : la CSP interdit les images data:).
    app.get('/api/me/2fa/qr.svg', requireUser, (req, res) => {
      const u = q.user.get(req.user.id), s = open(u.totp_pending);
      if (!s) return res.status(404).json({ error: 'Introuvable.' });
      const qr = qrcode(0, 'M');
      qr.addData(otpauthUri({ secret: s, account: u.username }));
      qr.make();
      res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }).send(qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true }));
    });
    app.post('/api/me/2fa/enable', requireUser, json, (req, res) => {
      const u = q.user.get(req.user.id), s = open(u.totp_pending);
      if (!s) return res.status(400).json({ error: 'Recommencez la mise en place.' });
      const step = verifyCode(s, req.body?.code);
      if (step === null) return res.status(400).json({ error: 'Code incorrect.' });
      q.enable.run(seal(s), step, u.id);
      const codes = newCodes(u.id);
      log.audit(req, 'auth.2fa.enable');
      res.set('Cache-Control', 'no-store').json({ ok: true, recoveryCodes: codes });
    });
    // Désactiver ou régénérer les codes de secours : mot de passe + code (TOTP ou secours).
    const confirm = async (req, res) => {
      const u = q.user.get(req.user.id);
      if (!u.totp_enabled) { res.status(400).json({ error: 'La double authentification n\'est pas active.' }); return null; }
      if (!(await verifyPassword(String(req.body?.password ?? ''), u.pass_hash))) {
        log.auth('AUTH_FAIL', { ip: req.ip, user: u.username, reason: 'totp_change' });
        res.status(400).json({ error: 'Mot de passe actuel incorrect.' }); return null;
      }
      if (!codeLimit(`2fa:${req.ip}`)) { res.status(429).json({ error: 'Trop de tentatives, réessayez dans une minute.' }); return null; }
      if (!checkCode(u, req.body?.code)) { res.status(400).json({ error: 'Code incorrect.' }); return null; }
      return u;
    };
    app.post('/api/me/2fa/disable', requireUser, json, async (req, res) => {
      const u = await confirm(req, res);
      if (!u) return;
      q.disable.run(u.id); q.clearCodes.run(u.id);
      log.audit(req, 'auth.2fa.disable');
      res.json({ ok: true });
    });
    app.post('/api/me/2fa/recovery', requireUser, json, async (req, res) => {
      const u = await confirm(req, res);
      if (!u) return;
      const codes = newCodes(u.id);
      log.audit(req, 'auth.2fa.recovery');
      res.set('Cache-Control', 'no-store').json({ ok: true, recoveryCodes: codes });
    });
  }

  // Remise à zéro par l'administrateur (téléphone perdu sans code de secours).
  const reset = (userId) => { q.disable.run(userId); q.clearCodes.run(userId); };
  return { startTicket, routes, reset, encrypted };
}
