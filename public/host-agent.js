// Outils de l'assistant IA dans une application (voir agent.js). Avec une API de pilotage (window.<app> : commands,
// execute, request, docInspect) : chercher parmi ses commandes (des centaines : SolidCraft 642, VectorCraft 1431),
// les exécuter, lire l'état du document. Toujours : contexte, enregistrer, renommer le fichier dans Crafty.
// x : ce que la page hôte partage (application, document, enregistrement).
import { api } from '/ui.js';
import { plain } from '/agent.js';

export function hostTools(x) {
  let cache = null;
  const commands = async () => {
    if (cache) return cache;
    const c = await x.api().commands();
    cache = (Array.isArray(c) ? c : c?.commands || []).map((k) => (typeof k === 'string' ? { id: k } : k));
    return cache;
  };
  const describe = (k) => ({ id: k.id, label: k.label || undefined, enabled: k.enabled ?? undefined, why: k.disabled_reason || undefined,
    params: typeof k.params === 'string' ? k.params.slice(0, 700) : k.params ? JSON.stringify(k.params).slice(0, 700) : undefined });

  return () => {
    const list = [
      { name: 'get_context', label: () => 'Lecture du contexte',
        description: 'Application, document ouvert, état d\'enregistrement, et si l\'application peut être pilotée.',
        run: () => ({ app: x.slug, appName: x.appName, document: x.docName() || null, stored: !!x.file(), status: x.status(), canControl: x.hasApi() }) },
      { name: 'save_document', label: () => 'Enregistrement',
        description: 'Enregistre le document dans Crafty (comme Ctrl+S ; un nouveau document demande un nom à l\'utilisateur).',
        run: () => x.save() },
      { name: 'rename_document', label: (a) => `Renommage en « ${a.name} »`,
        description: 'Renomme le fichier du document dans Crafty (garder l\'extension). Seulement s\'il est déjà enregistré.',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        run: async (a) => {
          const f = x.file();
          if (!f) throw new Error('le document n\'est pas encore enregistré dans Crafty');
          await api(`/api/files/${f.id}`, { method: 'PATCH', body: { name: a.name } });
          await x.renamed(a.name);
          return { ok: true, name: a.name };
        } },
    ];
    if (!x.hasApi()) return list;
    return [...list,
      { name: 'list_commands', label: (a) => `Recherche de commandes${a.query ? ` « ${a.query} »` : ''}`,
        description: 'Cherche parmi les commandes de l\'application (mots-clés en anglais, tous requis, dans l\'id, le libellé ou les paramètres). Renvoie id, libellé, paramètres attendus, disponibilité.',
        parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } } },
        run: async (a) => {
          const all = await commands(), words = String(a.query || '').toLowerCase().split(/\s+/).filter(Boolean);
          const hits = all.filter((k) => { const t = `${k.id} ${k.label || ''} ${typeof k.params === 'string' ? k.params : ''}`.toLowerCase(); return words.every((w) => t.includes(w)); });
          // Les correspondances dans l'id ou le libellé d'abord.
          hits.sort((p, q) => Number(words.some((w) => `${q.id} ${q.label || ''}`.toLowerCase().includes(w))) - Number(words.some((w) => `${p.id} ${p.label || ''}`.toLowerCase().includes(w))));
          return { total: hits.length, commands: hits.slice(0, Math.min(a.limit || 25, 60)).map(describe) };
        } },
      { name: 'run_command', label: (a) => `Commande ${a.id}`,
        description: 'Exécute une commande de l\'application avec ses paramètres (objet). method : "execute" (défaut) ou "request" pour les commandes de type requête.',
        parameters: { type: 'object', properties: { id: { type: 'string' }, params: { type: 'object' }, method: { type: 'string', enum: ['execute', 'request'] } }, required: ['id'] },
        run: async (a) => {
          const app = x.api(), fn = a.method === 'request' ? app.request : app.execute;
          const r = await fn.call(app, a.id, a.params || {});
          x.touched();
          return { result: plain(r) };
        } },
      { name: 'inspect_document', label: () => 'Lecture du document',
        description: 'État du document ouvert (structure, sélection, contenu résumé selon l\'application).',
        run: async () => {
          const app = x.api();
          const r = app.docInspect ? await app.docInspect() : app.inspect ? await app.inspect() : await app.execute('document.inspect', {});
          return plain(r);
        } },
    ];
  };
}
