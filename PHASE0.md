# Phase 0 : prototype jetable du mode hôte (PdfCraft puis WordCraft)

Lis d'abord `CLAUDE.md`. Cette phase sert à **vérifier par l'expérience** ce que la documentation
annonce, avant d'écrire le vrai serveur. Le code peut rester simple ; les réponses, elles, doivent être sûres.

## À construire

```
craft-host/
  CLAUDE.md
  package.json              # express seul comme dépendance
  apps.json                 # slug, version épinglée, nom du zip, sha256 si la release en publie un
  server.js                 # moins de 150 lignes
  scripts/fetch-app.mjs     # télécharge et décompresse une release dans vendor/<slug>/<version>/
  public/host.html          # page hôte
  public/host.js
  test/                     # node:test : MIME, 404, en-têtes de cache
  vendor/                   # dans .gitignore, recréé par fetch-app.mjs
  FINDINGS.md               # le vrai livrable (voir plus bas)
```

1. **`scripts/fetch-app.mjs <slug>`** : lister les releases de `storytold/<slug>` (`gh release list`, ou l'API REST),
   prendre la dernière qui contient un fichier `<slug>-web-<version>.zip`, le télécharger, vérifier son
   empreinte SHA-256 si la release en publie une, le décompresser dans `vendor/<slug>/<version>/`, et
   écrire la version dans `apps.json`. Ne modifie jamais un fichier décompressé. Si aucun zip web
   n'existe pour une application, dis-le et arrête-toi.
2. **`server.js`** : Express, écoute sur `127.0.0.1` seulement. Sert `/apps/<slug>/` depuis
   `vendor/<slug>/<version>/` avec : `.wasm` en `application/wasm`, compression gzip/Brotli, cache
   `immutable` sur les fichiers au nom haché, `no-cache` sur `index.html`, **404 pour tout fichier absent**.
   Sert `public/` à la racine. Un point d'entrée `POST /api/echo` qui répond 200 en stockant le corps en
   mémoire (pour simuler un stockage) et `GET /api/echo/:id` qui le rend.
3. **`public/host.html` + `host.js`** : `?app=pdfcraft` (ou `wordcraft`) choisit l'application.
   - Iframe de même origine : `src="/apps/<slug>/?host=parent"` (+ `&webgl` ou `&cpu` si demandé dans l'URL de la page hôte).
   - Écouteur `message` qui vérifie `event.origin === location.origin` et `event.source === iframe.contentWindow`,
     et affiche **chaque message reçu** dans un journal à l'écran (type, champs, taille des `bytes`).
   - Sur `<slug>:ready` : envoyer `<slug>:host` avec `{ version: "1" }`.
   - Bouton « Ouvrir un fichier » (input fichier) : lit le fichier, envoie `<slug>:open` avec `{ name, bytes }`,
     `bytes` transféré (`postMessage(msg, origin, [buffer])`).
   - Sur `<slug>:save` : afficher nom, taille, `saveAs`, `id` ; envoyer les octets à `POST /api/echo` ;
     **si le `save` porte un `id` et que la réponse est 2xx**, envoyer `<slug>:saved` avec `{ id }` ; sinon ne rien envoyer.
   - Sur `dirty` et `failed` : afficher l'état.
   - Un bouton « Télécharger la dernière sauvegarde » qui relit `GET /api/echo/:id`.

## À établir (écris les réponses dans `FINDINGS.md`, avec ce que tu as vu et non ce que tu supposes)

Pour chaque question, indique : **vérifié** (comment), **non vérifié** (pourquoi), et pour chaque application.

1. Les messages réels : chaînes de `type` exactes, champs présents dans `ready` (`version`, `appVersion`, `file`).
   Y a-t-il des messages non documentés ?
2. Ouvrir un document : le contenu s'affiche-t-il ? Que fait l'application d'un fichier invalide (message `failed` ?).
3. Enregistrer (Ctrl+S, « Enregistrer sous », export) : le `save` porte-t-il un `id` ? `saveAs` vaut quoi dans chaque cas ?
   Après `saved`, l'indicateur « modifié » (`dirty:false`) arrive-t-il ? Sans `saved`, l'application reste-t-elle « modifiée » ?
4. Le même fichier réenregistré deux fois de suite : même `id` ou un nouveau ?
5. **Gros fichiers** : si `ready.file` vaut `true`, ouvrir un `Blob` avec `{ name, file, size }` et un fichier d'environ 100 Mo
   (PDF généré, ou le plus gros fichier raisonnable pour WordCraft) ; mesurer la mémoire du navigateur par rapport à `bytes`.
6. **`?control`** : avec `?host=parent&control`, `iframe.contentWindow.<slug>` expose-t-il `commands()` et `execute()` ?
   Quel est l'identifiant réel de la commande d'enregistrement (liste fournie par `commands()`) ? Appeler `execute(<id>)` sur
   un document modifié déclenche-t-il un `save` sans ouvrir de boîte de dialogue ni gêner l'utilisateur ? C'est la base de la
   sauvegarde automatique.
7. **CSP** : la politique la plus stricte qui laisse les deux applications fonctionner (ouverture, enregistrement, reconnaissance de
   texte de PdfCraft si disponible). Pars de `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:;
   img-src 'self' data: blob:; connect-src 'self'` et note ce qui casse, avec le message de la console.
8. **Aiguillage** : une des deux applications envoie-t-elle un `handoff` dans un scénario simple (par exemple insérer ou joindre un
   fichier d'un autre format) ? Si tu ne trouves pas de scénario, écris-le.
9. Poids et temps : octets transférés (compressés) et temps jusqu'à `ready`, pour chaque application, sur ta machine.
10. Différences de comportement entre PdfCraft et WordCraft sur tout ce qui précède.
11. Tests automatiques : un navigateur sans écran (Playwright + Chromium) peut-il charger les applications ? Les drapeaux `?webgl`
    ou `?cpu` sont documentés pour les cas sans WebGPU. Si oui, écris un test qui ouvre un fichier et vérifie la réception de `ready`
    et d'un `save` ; sinon, décris les vérifications à faire à la main.

## Critères de fin

- `npm test` passe (MIME du wasm, 404 sur un fichier absent, en-têtes de cache, en-tête de compression).
- Dans un vrai navigateur, pour PdfCraft **et** WordCraft : ouvrir un fichier, le modifier, l'enregistrer, recevoir `saved`,
  recharger la page hôte et retrouver le fichier enregistré via `GET /api/echo/:id`.
- `FINDINGS.md` répond aux 11 questions, chacune avec son statut (vérifié / non vérifié).
- Aucun fichier de `vendor/` n'a été modifié (vérifie-le avec une empreinte avant et après).

## Ce qu'il ne faut pas faire

- Ne pas écrire de comptes, de sessions ni de base de données : c'est la phase 1.
- Ne pas modifier les applications, ni contourner une règle du contrat parce qu'elle gêne : note-le dans `FINDINGS.md`.
- Ne rien exposer hors de `localhost`.
- Ne pas passer à la phase 1 sans mon accord : à la fin, mets à jour `PLAN.md` et `CLAUDE.md` avec ce que la phase 0 a établi
  ou contredit, puis résume les surprises et ce qui change dans le plan.
