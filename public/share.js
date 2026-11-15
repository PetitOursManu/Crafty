// Page publique d'un lien de partage (voir src/shares.js) : aperçu quand le type s'y prête, téléchargement.
import { h, icon, formatSize, formatDate } from '/ui.js';

const token = location.pathname.split('/').pop();
const view = document.getElementById('view');
const base = `/api/s/${encodeURIComponent(token)}`;

async function main() {
  const r = await fetch(base, { credentials: 'omit', cache: 'no-store' });
  if (!r.ok) {
    const e = await r.json().catch(() => null);
    view.replaceChildren(h('div', { class: 'share-card' }, h('h1', {}, 'Lien indisponible'), h('p', { class: 'mut' }, e?.error || 'Ce lien n\'existe pas ou a expiré.')));
    return;
  }
  const m = await r.json();
  document.title = `${m.name} · Crafty`;
  const meta = [formatSize(m.size), `modifié ${formatDate(m.updatedAt)}`, `partagé par ${m.sharedBy}`, m.expiresAt ? `lien valable jusqu'au ${new Date(m.expiresAt).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })}` : null].filter(Boolean).join(' · ');
  const preview = h('div', { class: 'share-preview' });
  if (m.preview === 'image') preview.append(h('img', { src: `${base}/content`, alt: m.name }));
  else if (m.preview === 'pdf') preview.append(h('iframe', { src: `${base}/content`, title: m.name }));
  else if (m.preview === 'text') {
    const t = await fetch(`${base}/content`, { credentials: 'omit' }).then((x) => x.text()).catch(() => '');
    preview.append(h('pre', {}, t.length > 200_000 ? `${t.slice(0, 200_000)}\n…` : t));
  } else preview.append(h('p', { class: 'mut' }, 'Pas d\'aperçu pour ce type de fichier : téléchargez-le.'));
  view.replaceChildren(h('div', { class: 'share-card' },
    h('div', { class: 'share-head' }, h('div', {}, h('h1', {}, m.name), h('p', { class: 'mut' }, meta)),
      h('a', { class: 'btn primary', href: `${base}/content?dl=1`, download: m.name }, icon('download'), 'Télécharger')),
    preview));
}
main().catch(() => view.replaceChildren(h('p', { class: 'error-text' }, 'Chargement impossible.')));
