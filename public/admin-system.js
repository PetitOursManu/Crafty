// Administration → Système : adresse IP vue par le serveur (vérification de TRUST_PROXY), connexion unique Dashy,
// chiffrement des secrets, sauvegardes de la base.
import { api, h, toast, formatSize, formatDateTime } from '/ui.js';
import { t } from '/i18n.js';

const VERDICTS = {
  ok: () => [t('Correct'), 'ok', t('L\'adresse retenue est celle que Cloudflare a reçue du visiteur.')],
  'cloudflare-mismatch': () => [t('À corriger'), 'danger', t('L\'adresse retenue n\'est pas celle du visiteur (CF-Connecting-IP) : ajustez TRUST_PROXY (nombre de proxys entre le visiteur et Crafty) et la confiance de Traefik envers Cloudflare.')],
  proxy: () => [t('À confirmer'), 'warn', t('Un proxy transmet X-Forwarded-For et il est pris en compte : comparez l\'adresse retenue avec votre adresse publique.')],
  'proxy-untrusted': () => [t('À corriger'), 'danger', t('Un proxy transmet X-Forwarded-For mais TRUST_PROXY l\'ignore : toutes les connexions semblent venir du proxy (limites par IP et fail2ban communs à tous).')],
  direct: () => [t('Connexion directe'), 'ok', t('Aucun proxy : l\'adresse retenue est celle de la connexion.')],
};

const kv = (rows) => h('dl', { class: 'kv' }, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')]));

async function networkCard() {
  const out = h('div');
  const run = async () => {
    try {
      const n = await api('/api/admin/network');
      const [label, kind, text] = (VERDICTS[n.verdict] || VERDICTS.direct)();
      out.replaceChildren(
        h('p', {}, h('span', { class: `badge ${kind === 'ok' ? 'accent' : kind}` }, label), ' ', text),
        kv([[t('Adresse retenue'), h('code', {}, n.ip)], [t('Chaîne (proxys de confiance)'), h('code', {}, (n.ips || []).join(', ') || '—')],
          [t('Connexion reçue de'), h('code', {}, n.socket)], ['TRUST_PROXY', h('code', {}, n.trustProxy)],
          [t('HTTPS vu par le serveur'), n.secure ? t('oui') : t('non')],
          ...Object.entries(n.headers).map(([k, v]) => [k, v ? h('code', {}, v) : '—'])]));
    } catch (e) { toast({ type: 'error', title: t('Vérification impossible'), detail: e.message }); }
  };
  await run();
  return h('div', { class: 'card' }, h('h3', {}, t('Adresse IP réelle')),
    h('p', { class: 'mut' }, t('Les limites de connexion, le verrouillage et fail2ban se fondent sur cette adresse. Ouvrez cette page depuis l\'extérieur (par le domaine public) pour vérifier.')),
    out, h('div', {}, h('button', { class: 'btn', type: 'button', onclick: run }, t('Vérifier à nouveau'))));
}

export async function renderSystem(el) {
  const s = await api('/api/admin/system');
  const sso = s.sso.dashy
    ? kv([[t('État'), h('span', { class: 'badge accent' }, t('activée'))], [t('Dashy'), h('code', {}, s.sso.dashyUrl)],
      [t('Adresse de retour à autoriser dans Dashy'), h('code', {}, s.sso.callback)]])
    : h('p', { class: 'mut' }, t('Désactivée. Pour l\'activer : SSO_SHARED_SECRET (le même que dans Dashy), SSO_DASHY_URL et PUBLIC_ORIGIN dans l\'environnement du conteneur (docs/DEPLOIEMENT.md).'));
  const backups = s.backups.length
    ? h('table', { class: 'table compact' }, h('thead', {}, h('tr', {}, h('th', {}, t('Instantané')), h('th', {}, t('Taille')), h('th', {}, t('Date')))),
      h('tbody', {}, s.backups.map((b) => h('tr', {}, h('td', {}, h('code', {}, b.name)), h('td', {}, formatSize(b.size)), h('td', { class: 'mut' }, formatDateTime(b.at))))))
    : h('p', { class: 'mut' }, t('Aucun instantané pour l\'instant.'));
  el.replaceChildren(
    await networkCard(),
    h('div', { class: 'card' }, h('h3', {}, t('Connexion unique (Dashy)')), sso),
    h('div', { class: 'card' }, h('h3', {}, t('Secrets')),
      h('p', {}, s.secretsEncrypted
        ? t('Clés des fournisseurs d\'IA et secrets de double authentification chiffrés avec CRAFTY_SECRET.')
        : h('span', {}, h('span', { class: 'badge warn' }, t('en clair')), ' ', t('CRAFTY_SECRET n\'est pas défini : clés d\'IA et secrets de double authentification sont gardés en clair dans la base.')))),
    h('div', { class: 'card' }, h('h3', {}, t('Sauvegardes de la base')),
      h('p', { class: 'mut' }, s.backupEveryHours
        ? t('Instantané automatique toutes les {n} h dans DATA_DIR/backups (à copier hors du serveur avec le reste du volume).', { n: s.backupEveryHours })
        : t('Instantané automatique désactivé (BACKUP_EVERY_HOURS). À la main : node scripts/backup.mjs')),
      backups));
}
