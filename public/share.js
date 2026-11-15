// Page publique d'un lien de partage (voir src/shares.js) : aperçu quand le type s'y prête, téléchargement.
import { h, icon, formatSize, formatDate } from '/ui.js';
import { t, locale, translateDom } from '/i18n.js';

translateDom();

const token = location.pathname.split('/').pop();
const view = document.getElementById('view');
const base = `/api/s/${encodeURIComponent(token)}`;

async function main() {
  const r = await fetch(base, { credentials: 'omit', cache: 'no-store' });
  if (!r.ok) {
    const e = await r.json().catch(() => null);
    view.replaceChildren(h('div', { class: 'share-card' }, h('h1', {}, t('Lien indisponible')), h('p', { class: 'mut' }, e?.error || t('Ce lien n\'existe pas ou a expiré.'))));
    return;
  }
  const m = await r.json();
  document.title = `${m.name} · Crafty`;
  const meta = [formatSize(m.size), t('modifié {date}', { date: formatDate(m.updatedAt) }), t('partagé par {name}', { name: m.sharedBy }),
    m.expiresAt ? t('lien valable jusqu\'au {date}', { date: new Date(m.expiresAt).toLocaleString(locale, { dateStyle: 'long', timeStyle: 'short' }) }) : null].filter(Boolean).join(' · ');
  const preview = h('div', { class: 'share-preview' });
  if (m.preview === 'image') preview.append(h('img', { src: `${base}/content`, alt: m.name }));
  else if (m.preview === 'pdf') preview.append(h('iframe', { src: `${base}/content`, title: m.name }));
  else if (m.preview === 'text') {
    const txt = await fetch(`${base}/content`, { credentials: 'omit' }).then((x) => x.text()).catch(() => '');
    preview.append(h('pre', {}, txt.length > 200_000 ? `${txt.slice(0, 200_000)}\n…` : txt));
  } else preview.append(h('p', { class: 'mut' }, t('Pas d\'aperçu pour ce type de fichier : téléchargez-le.')));
  view.replaceChildren(h('div', { class: 'share-card' },
    h('div', { class: 'share-head' }, h('div', {}, h('h1', {}, m.name), h('p', { class: 'mut' }, meta)),
      h('a', { class: 'btn primary', href: `${base}/content?dl=1`, download: m.name }, icon('download'), t('Télécharger'))),
    preview));
}
main().catch(() => view.replaceChildren(h('p', { class: 'error-text' }, t('Chargement impossible.'))));
