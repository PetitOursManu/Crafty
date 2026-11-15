// Outils de l'assistant IA sur l'accueil (voir agent.js) : lister, chercher, filtrer, sélectionner, créer, renommer,
// déplacer, supprimer (avec confirmation), ouvrir. Éléments désignés par { type: "file" | "folder", id }.
// x : ce que l'explorateur partage (état, rechargement, affichage).
import { api, extOf } from '/ui.js';
import { t } from '/i18n.js';

export function explorerTools(x) {
  const seen = new Map(); // id → nom, pour des confirmations lisibles
  const itemOut = (type, it, path) => {
    seen.set(it.id, it.name);
    return { type, id: it.id, name: it.name, ...(type === 'file' ? { size: it.size, modified: new Date(it.updatedAt).toISOString().slice(0, 16), lastApp: it.lastApp || null } : {}), ...(path ? { path } : {}) };
  };
  const ITEMS = { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['file', 'folder'] }, id: { type: 'string' } }, required: ['type', 'id'] } };
  const FOLDER_ID = { type: ['string', 'null'], description: 'Identifiant du dossier ; null ou absent : la racine « Mes fichiers »' };
  const kindOf = (it) => (it.type === 'folder' ? 'folders' : 'files');
  const keyOf = (it) => `${it.type === 'folder' ? 'd' : 'f'}:${it.id}`;
  const named = (id, fallback = '…') => t('« {name} »', { name: seen.get(id) || fallback });
  async function listing(folderId) {
    const d = await api(`/api/fs?folder=${encodeURIComponent(folderId || 'root')}`);
    return { folder: d.folder ? { id: d.folder.id, name: d.folder.name } : null, path: ['Mes fichiers', ...d.path.map((p) => p.name)].join(' / '),
      folders: d.folders.map((f) => itemOut('folder', f)), files: d.files.map((f) => itemOut('file', f)) };
  }
  // Exécute une action par élément, recharge l'affichage une fois, et renvoie les erreurs par nom.
  async function each(items, fn) {
    const errors = [];
    for (const it of items) {
      try { await fn(it); } catch (e) { if (e.status !== 404 || fn.name !== 'del') errors.push(`${seen.get(it.id) || it.id} : ${e.message}`); }
    }
    await x.reload();
    return { done: items.length - errors.length, errors };
  }

  return () => [
    { name: 'list_folder', label: (a) => t('Lecture du dossier {name}', { name: a.folder_id ? named(a.folder_id) : t('Mes fichiers') }),
      description: 'Liste les sous-dossiers et fichiers d\'un dossier (nom, id, taille, date, dernière application).',
      parameters: { type: 'object', properties: { folder_id: FOLDER_ID } }, run: (a) => listing(a.folder_id) },
    { name: 'search_files', label: (a) => `${t('Recherche')}${a.query ? ` ${t('« {name} »', { name: a.query })}` : ''}${a.extension ? ` .${a.extension}` : ''}`,
      description: 'Cherche dans tous les dossiers du compte : nom contenant le texte, et/ou extension. Donne le chemin de chaque résultat.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, extension: { type: 'string', description: 'sans le point, ex. pdf' }, max: { type: 'integer' } } },
      run: async (a) => {
        const q = String(a.query || '').toLowerCase(), ext = String(a.extension || '').toLowerCase().replace(/^\./, ''), max = Math.min(a.max || 200, 500);
        const out = [], queue = [{ id: null, path: 'Mes fichiers' }];
        let scanned = 0;
        while (queue.length && scanned < 400 && out.length < max) {
          const cur = queue.shift(); scanned++;
          const d = await api(`/api/fs?folder=${encodeURIComponent(cur.id || 'root')}`);
          for (const f of d.folders) {
            queue.push({ id: f.id, path: `${cur.path} / ${f.name}` });
            if (q && !ext && f.name.toLowerCase().includes(q)) out.push(itemOut('folder', f, cur.path));
          }
          for (const f of d.files) if ((!q || f.name.toLowerCase().includes(q)) && (!ext || extOf(f.name) === ext)) out.push(itemOut('file', f, cur.path));
        }
        return { results: out.slice(0, max), complete: !(out.length >= max || queue.length) };
      } },
    { name: 'show_folder', label: (a) => t('Ouverture du dossier {name}', { name: a.folder_id ? named(a.folder_id) : t('Mes fichiers') }),
      description: 'Affiche ce dossier à l\'utilisateur dans l\'explorateur.', parameters: { type: 'object', properties: { folder_id: FOLDER_ID } },
      run: async (a) => ({ shown: await x.show(a.folder_id || null) }) },
    { name: 'filter_view', label: (a) => (a.text ? t('Filtre « {text} »', { text: a.text }) : t('Filtre retiré')),
      description: 'Filtre l\'affichage du dossier ouvert sur un texte (nom contenant) ; texte vide pour tout réafficher.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      run: (a) => ({ visible: x.filter(String(a.text || '').trim()) }) },
    { name: 'select_items', label: (a) => t('Sélection de {n} élément(s)', { n: a.items?.length || 0 }),
      description: 'Sélectionne (surligne) des éléments du dossier affiché, pour les montrer à l\'utilisateur.',
      parameters: { type: 'object', properties: { items: ITEMS }, required: ['items'] },
      run: (a) => ({ selected: x.select(a.items.map(keyOf)) }) },
    { name: 'create_folder', label: (a) => t('Création du dossier « {name} »', { name: a.name }),
      description: 'Crée un dossier (dans parent_id, ou à la racine).', parameters: { type: 'object', properties: { name: { type: 'string' }, parent_id: FOLDER_ID }, required: ['name'] },
      run: async (a) => { const f = await api('/api/folders', { method: 'POST', body: { parentId: a.parent_id || null, name: a.name } }); await x.reload(); return itemOut('folder', f); } },
    { name: 'rename_item', label: (a) => t('Renommage en « {name} »', { name: a.name }),
      description: 'Renomme un fichier ou un dossier (garder l\'extension d\'un fichier).',
      parameters: { type: 'object', properties: { type: { type: 'string', enum: ['file', 'folder'] }, id: { type: 'string' }, name: { type: 'string' } }, required: ['type', 'id', 'name'] },
      run: async (a) => { await api(`/api/${kindOf(a)}/${a.id}`, { method: 'PATCH', body: { name: a.name } }); seen.set(a.id, a.name); await x.reload(); return { ok: true }; } },
    { name: 'move_items', label: (a) => t('Déplacement de {n} élément(s)', { n: a.items?.length || 0 }),
      description: 'Déplace des fichiers et dossiers dans un dossier (target_folder_id null = racine).',
      parameters: { type: 'object', properties: { items: ITEMS, target_folder_id: FOLDER_ID }, required: ['items'] },
      run: (a) => each(a.items, (it) => api(`/api/${kindOf(it)}/${it.id}`, { method: 'PATCH',
        body: it.type === 'folder' ? { parentId: a.target_folder_id || null } : { folderId: a.target_folder_id || null } })) },
    { name: 'delete_items', label: (a) => t('Suppression de {n} élément(s)', { n: a.items?.length || 0 }),
      description: 'Met des fichiers et des dossiers (avec leur contenu) à la corbeille, d\'où ils peuvent être restaurés pendant le délai fixé par l\'admin (suppression définitive si la corbeille est désactivée). L\'utilisateur confirme dans le panneau.',
      parameters: { type: 'object', properties: { items: ITEMS }, required: ['items'] },
      confirm: (a) => `${t('Mettre {n} élément(s) à la corbeille ?', { n: a.items.length })}\n${a.items.slice(0, 12).map((it) => `• ${it.type === 'folder' ? t('dossier') : t('fichier')} ${named(it.id, it.id)}`).join('\n')}${a.items.length > 12 ? `\n${t('… et {n} autre(s)', { n: a.items.length - 12 })}` : ''}`,
      run: (a) => each(a.items, async function del(it) { await api(`/api/${kindOf(it)}/${it.id}`, { method: 'DELETE' }); x.unselect(keyOf(it)); }) },
    { name: 'open_file', label: (a) => t('Ouverture de {name}', { name: named(a.file_id, t('fichier')) }),
      description: 'Ouvre un fichier dans une application (quitte l\'accueil : la conversation se termine). app : slug, sinon l\'application par défaut.',
      parameters: { type: 'object', properties: { file_id: { type: 'string' }, app: { type: 'string' } }, required: ['file_id'] },
      run: async (a) => { const f = await api(`/api/files/${a.file_id}`); setTimeout(() => x.open(f, a.app || undefined), 1200); return { opening: f.name }; } },
    { name: 'list_apps', label: () => t('Liste des applications'), description: 'Applications disponibles et formats qu\'elles éditent ou ouvrent.',
      run: () => x.apps().map((a) => ({ slug: a.slug, name: a.name, description: a.description, edits: a.extensions, opens: a.imports })) },
    { name: 'list_trash', label: () => t('Lecture de la corbeille'), description: 'Éléments dans la corbeille (nom, origine, date de suppression, date d\'effacement définitif).',
      run: async () => (await api('/api/trash')).items.map((it) => { seen.set(it.id, it.name); return it; }) },
    { name: 'restore_items', label: (a) => t('Restauration de {n} élément(s)', { n: a.items?.length || 0 }),
      description: 'Restaure des éléments de la corbeille (à leur place si leur dossier existe encore, sinon dans « Mes fichiers »).',
      parameters: { type: 'object', properties: { items: ITEMS }, required: ['items'] },
      run: async (a) => { const r = await api('/api/trash/restore', { method: 'POST', body: { items: a.items } }); await x.reload(); return r; } },
    { name: 'set_favorite', label: (a) => (a.on ? t('Ajout aux favoris') : t('Retrait des favoris')), description: 'Ajoute ou retire un fichier ou un dossier des favoris (accès rapide de l\'accueil).',
      parameters: { type: 'object', properties: { type: { type: 'string', enum: ['file', 'folder'] }, id: { type: 'string' }, on: { type: 'boolean' } }, required: ['type', 'id', 'on'] },
      run: async (a) => { await api('/api/favorites', { method: 'PUT', body: a }); await x.reload(); return { ok: true }; } },
    { name: 'storage_usage', label: () => t('Espace utilisé'), description: 'Espace utilisé et quota du compte (octets).', run: () => api('/api/usage') },
  ];
}
