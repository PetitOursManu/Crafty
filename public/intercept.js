// Interceptions dans la fenêtre de l'iframe (même origine ; aucun fichier de l'application n'est modifié) :
// - boîte « Ouvrir » : <input type="file">.click()/showPicker() et showOpenFilePicker() → sélecteur Crafty ;
// - enregistrement par téléchargement : <a download href="blob:|data:"> et showSaveFilePicker() → stockage Crafty.
// Sert aux applications sans pont (mode « intercept ») et, pour les téléchargements, aux exports des autres
// (PdfCraft exporte en téléchargement, vérifié en phase 0).
// URL.createObjectURL est suivi pour garder le Blob : beaucoup d'applications révoquent l'URL juste après le clic.

export function installInterceptors(w, h) {
  if (!w || w.__craftIntercept) return;
  w.__craftIntercept = true;

  // --- Ouvrir : champ fichier ---
  const ip = w.HTMLInputElement.prototype;
  const wrapInput = (orig) => function (...args) {
    if (this.type !== 'file') return orig?.apply(this, args);
    h.pickInput(this);
  };
  ip.click = wrapInput(ip.click);
  if (ip.showPicker) ip.showPicker = wrapInput(ip.showPicker);

  // --- Ouvrir : API d'accès aux fichiers (Chromium) ---
  // wasm-bindgen vérifie les types par `instanceof` dans le contexte de l'iframe (dyn_into, JsFuture) : un objet
  // ordinaire ou une Promise créée par cette page-ci (autre contexte) est refusé, et l'application attend une réponse
  // qui ne vient jamais (vérifié avec SolidCraft : « no answer from the file dialog »). D'où les prototypes de l'iframe
  // (FileSystemFileHandle…) et des fonctions qui rendent des Promise et des tableaux de l'iframe.
  const A = (fn) => (...a) => w.Promise.resolve().then(() => fn(...a));
  const brand = (ctor, props) => {
    const o = Object.create(w[ctor]?.prototype || w.Object.prototype);
    for (const [k, v] of Object.entries(props)) Object.defineProperty(o, k, { value: v, enumerable: true });
    return o;
  };
  const handle = (name, getFile) => brand('FileSystemFileHandle', {
    kind: 'file', name,
    getFile: A(getFile),
    createWritable: A(() => writable(name)),
    createSyncAccessHandle: A(() => { throw new w.DOMException('Not supported', 'NotSupportedError'); }),
    queryPermission: A(() => 'granted'), requestPermission: A(() => 'granted'),
    isSameEntry: A((o) => o?.name === name),
  });
  const fileHandle = (file) => handle(file.name, () => file);
  w.showOpenFilePicker = A(async (opts = {}) => {
    const files = await h.pickHandles(opts);
    if (!files?.length) throw new w.DOMException('The user aborted a request.', 'AbortError');
    return w.Array.from(files, fileHandle);
  });

  // --- Enregistrer : showSaveFilePicker → écriture recueillie, stockée à la fermeture ---
  function writable(name) {
    let parts = [];
    const write = A((d) => {
      if (d && typeof d === 'object' && 'type' in d && !(d instanceof w.Blob) && !ArrayBuffer.isView(d) && !(d instanceof w.ArrayBuffer)) {
        if (d.type === 'truncate') { parts = []; return; }
        if (d.type !== 'write') return;
        d = d.data;
      }
      parts.push(d instanceof w.Blob ? d : new w.Blob([d]));
    });
    const close = A(() => { h.saveFile(name, new w.Blob(parts)); });
    const abort = A(() => { parts = []; });
    return brand('FileSystemWritableFileStream', {
      write, close, abort,
      seek: A(() => {}), truncate: A(() => { parts = []; }),
      getWriter: () => brand('Object', { write, close, abort, releaseLock() {}, ready: w.Promise.resolve(), closed: w.Promise.resolve() }),
    });
  }
  w.showSaveFilePicker = A((opts = {}) => handle(opts.suggestedName || 'document', () => new w.File([], opts.suggestedName || 'document')));

  // --- Enregistrer : téléchargement <a download> ---
  const blobs = new Map();
  const create = w.URL.createObjectURL;
  w.URL.createObjectURL = function (o) {
    const u = create.call(this, o);
    if (o instanceof w.Blob) { blobs.set(u, o); if (blobs.size > 64) blobs.delete(blobs.keys().next().value); }
    return u;
  };
  const isDownload = (a) => !!a && a.hasAttribute?.('download') && /^(blob:|data:)/.test(a.href || '');
  const capture = async (a) => {
    const name = a.getAttribute('download') || 'document';
    let blob = blobs.get(a.href);
    if (!blob && a.href.startsWith('data:')) blob = await (await fetch(a.href)).blob();
    if (blob) h.saveFile(name, blob);
    else h.saveLost?.(name);
  };
  const aClick = w.HTMLAnchorElement.prototype.click;
  w.HTMLAnchorElement.prototype.click = function (...args) {
    // Lien hors document : l'événement n'atteindrait pas l'écouteur ci-dessous.
    if (!this.isConnected && isDownload(this)) { capture(this); return; }
    return aClick.apply(this, args);
  };
  w.document.addEventListener('click', (e) => {
    const a = e.target?.closest?.('a[download]');
    if (!isDownload(a)) return;
    e.preventDefault();
    capture(a);
  }, true);
}

// Ouvre un fichier en le « déposant » sur l'application (glisser-déposer simulé), pour celles sans message `open`.
export function dropFile(w, file) {
  const target = w.document.querySelector('canvas') || w.document.body;
  const r = target.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true };
  const dt = new w.DataTransfer();
  dt.items.add(file);
  for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new w.DragEvent(type, { ...at, dataTransfer: dt }));
}
