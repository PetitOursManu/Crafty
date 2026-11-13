// Tableau de bord : une carte par application installée (GET /api/apps) et les fichiers enregistrés (GET /api/echo).
const $ = (id) => document.getElementById(id);
let apps = [];

function make(tag, props = {}, kids = []) {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) if (k != null) n.append(k);
  return n;
}
// Couleur stable par application, sans logo (les logos ArtCraft ne s'utilisent qu'inchangés, avec l'application).
function accent(slug) {
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 46%)`;
}
function options() {
  const p = new URLSearchParams();
  if ($('optControl').checked) p.append('control', '');
  if ($('optWebgl').checked) p.append('webgl', '');
  return p.toString().replace(/=(&|$)/g, '$1');
}
const hostUrl = (slug, extra = '') => `/host.html?app=${encodeURIComponent(slug)}${extra}${options() ? `&${options()}` : ''}`;

function renderApps() {
  const ul = $('apps');
  ul.replaceChildren(...apps.map((a) => {
    const link = make('a', { className: 'app', href: hostUrl(a.slug) }, [
      make('div', { className: 'app-head' }, [
        make('span', { className: 'tile', ariaHidden: 'true', textContent: a.name.slice(0, 1) }),
        make('div', {}, [make('div', { className: 'app-name', textContent: a.name }), make('div', { className: 'app-ver', textContent: `version ${a.version}` })]),
      ]),
      make('p', { className: 'app-desc', textContent: a.description }),
      a.extensions.length ? make('div', { className: 'chips' }, a.extensions.map((e) => make('span', { className: 'chip', textContent: `.${e}` }))) : null,
      make('span', { className: 'open', textContent: 'Ouvrir →' }),
    ]);
    link.style.setProperty('--accent', accent(a.slug));
    return make('li', {}, link);
  }));
  ul.ariaBusy = 'false';
  $('appsEmpty').hidden = apps.length > 0;
}

const size = (n) => n < 1024 ? `${n} o` : n < 1048576 ? `${(n / 1024).toFixed(1)} Kio` : `${(n / 1048576).toFixed(1)} Mio`;
const when = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });

async function renderFiles() {
  let files = [];
  try { files = await (await fetch('/api/echo', { cache: 'no-store' })).json(); } catch {}
  files.sort((a, b) => b.at.localeCompare(a.at));
  const tbody = $('files').querySelector('tbody');
  tbody.replaceChildren(...files.map((f) => {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const app = apps.find((a) => a.extensions.includes(ext));
    const action = app
      ? make('a', { className: 'btn', href: hostUrl(app.slug, `&open=${encodeURIComponent(f.id)}`), textContent: `Ouvrir dans ${app.name}` })
      : make('a', { className: 'btn', href: `/api/echo/${encodeURIComponent(f.id)}`, textContent: 'Télécharger' });
    return make('tr', {}, [
      make('td', { className: 'name', textContent: f.name }), make('td', { className: 'num', textContent: size(f.size) }),
      make('td', { className: 'num', textContent: when(f.at) }), make('td', {}, action),
    ]);
  }));
  $('files').hidden = files.length === 0;
  $('filesEmpty').hidden = files.length > 0;
}

// Options mémorisées pour ce navigateur seulement.
for (const id of ['optControl', 'optWebgl']) {
  try { $(id).checked = localStorage.getItem(`craft-host:${id}`) === '1'; } catch {}
  $(id).addEventListener('change', () => {
    try { localStorage.setItem(`craft-host:${id}`, $(id).checked ? '1' : '0'); } catch {}
    renderApps(); renderFiles();
  });
}
$('refresh').onclick = renderFiles;

try { apps = await (await fetch('/api/apps', { cache: 'no-store' })).json(); } catch { apps = []; }
renderApps();
renderFiles();
