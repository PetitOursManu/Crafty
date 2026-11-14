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
  const fileHandle = (file) => ({
    kind: 'file', name: file.name,
    getFile: async () => file,
    createWritable: async () => writable(file.name),
    queryPermission: async () => 'granted', requestPermission: async () => 'granted', isSameEntry: async (o) => o?.name === file.name,
  });
  w.showOpenFilePicker = async (opts = {}) => {
    const files = await h.pickHandles(opts);
    if (!files?.length) throw new w.DOMException('The user aborted a request.', 'AbortError');
    return files.map(fileHandle);
  };

  // --- Enregistrer : showSaveFilePicker → écriture recueillie, stockée à la fermeture ---
  function writable(name) {
    let parts = [];
    return {
      write: async (d) => {
        if (d && typeof d === 'object' && 'type' in d && !(d instanceof w.Blob) && !ArrayBuffer.isView(d) && !(d instanceof ArrayBuffer)) {
          if (d.type === 'truncate') { parts = []; return; }
          if (d.type !== 'write') return;
          d = d.data;
        }
        parts.push(d instanceof w.Blob ? d : new w.Blob([d]));
      },
      seek: async () => {}, truncate: async () => { parts = []; },
      close: async () => h.saveFile(name, new w.Blob(parts)),
      abort: async () => { parts = []; },
    };
  }
  w.showSaveFilePicker = async (opts = {}) => {
    const name = opts.suggestedName || 'document';
    return { kind: 'file', name, getFile: async () => new w.File([], name), createWritable: async () => writable(name),
      queryPermission: async () => 'granted', requestPermission: async () => 'granted', isSameEntry: async () => false };
  };

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
