# Phase 0 : constats

Établi le 13 novembre 2026 sur Windows 11, Chrome 157.0.8103.51 (installé), Node 24.22, serveur du prototype
sur `127.0.0.1`. Versions testées : **PdfCraft 0.21.1** (`pdfcraft-web-0.21.1.zip`) et **WordCraft 0.18.1**
(`wordcraft-web-0.18.1.zip`), toutes deux liées à `storytold/craft-libs` au commit `fd5e2fe` (lu dans leur `Cargo.lock`).

Légende : **vérifié** = observé en exécutant ; **lu** = trouvé dans le code ou la doc, pas observé ;
**non vérifié** = ni l'un ni l'autre.

Moyens d'observation :

- navigateur intégré de l'app Claude (PdfCraft, à la souris et au clavier) ;
- Chrome piloté par Playwright (`playwright-core`, Chrome installé ; le Chromium du cache Playwright de cette
  machine ne démarre pas : « configuration côte-à-côte incorrecte »), sans écran et avec écran (`HEADED=1`) ;
- `window.<app>` (`?control`) pour piloter et lire l'état (`docInspect`, `uiInspect`) ;
- journal de la page hôte (`public/host.js`), qui affiche chaque message reçu et envoyé.

## Résumé : ce qui change par rapport au plan

1. **Aucune des deux applications n'envoie d'`id` dans `save`.** L'hôte ne peut donc jamais répondre `saved`,
   et l'application se déclare « enregistrée » (`dirty:false`) **avant** de savoir si l'hôte a stocké le fichier,
   y compris quand le stockage répond 500. L'hôte doit tenir son propre état « non enregistré ».
2. **Aucune n'envoie `failed` pour un fichier refusé** (fichier invalide, mauvais format, `Blob` non pris en
   charge). L'erreur n'apparaît que dans l'application (notification) et dans la console.
3. **`ready.file` vaut `false` pour les deux** : pas d'ouverture par `Blob`, il faut envoyer `bytes`.
4. **Les exports de PdfCraft (Word, texte…) partent en téléchargement du navigateur**, pas en `save` : ils
   contournent l'hôte et le stockage. Ceux de WordCraft (PDF, PNG) passent bien par `save`.
5. **`window.wordcraft` existe sans `?control`** : dans WordCraft, tout script de la même origine peut piloter
   l'application, toujours. PdfCraft respecte `?control`.
6. **Sauvegarde automatique par `execute("file.save")` : fonctionne** dans les deux, sans boîte de dialogue,
   sans perdre la sélection ni le focus. Mais un onglet masqué ne répond pas tant qu'il n'est pas visible.
7. **CSP** : la politique de départ casse les deux applications (script et style en ligne dans `index.html`).
   Une politique stricte avec empreintes SHA-256 fonctionne, OCR compris. Trusted Types casse l'OCR.
8. **Poids réel 4 fois supérieur à la doc** : wasm de 60,6 Mo (PdfCraft) et 61,0 Mo (WordCraft) ; 16,2 et
   15,6 Mo en Brotli 9 ; 13,7 et 13,1 Mo en Brotli 11. La doc annonce « 13 MB, 5 MB compressé ».
9. Aucun `handoff` observé.
10. Playwright + Chrome sans écran charge les deux applications, même sans GPU : un test de bout en bout existe
    (`npm run test:e2e`).

Le critère de fin « recevoir `saved` » est **impossible à remplir** avec ces versions (point 1). Le reste du
parcours (ouvrir, modifier, enregistrer, recharger la page hôte, retrouver le fichier via `GET /api/echo/:id`)
est vérifié pour les deux.

---

## 1. Messages réels

**Vérifié** (journal de la page hôte, les deux applications).

| | PdfCraft 0.21.1 | WordCraft 0.18.1 |
|---|---|---|
| `ready` | `{type:"pdfcraft:ready", version:"1", appVersion:"0.21.1", file:false}` | `{type:"wordcraft:ready", version:"1", appVersion:"0.18.1", file:false}` |
| Après `ready` | rien | `wordcraft:dirty` `{dirty:false}` spontané, avant tout `open` |
| `open` reçu | aucun message en retour | aucun message en retour |
| Modification | `pdfcraft:dirty {dirty:true}` | `wordcraft:dirty {dirty:true}` |
| Enregistrement | `pdfcraft:save {name, bytes, saveAs}` puis `dirty:false` | `wordcraft:save {name, bytes, saveAs}` puis `dirty:false` |
| `id` dans `save` | jamais | jamais |
| `failed`, `handoff` | jamais observés | jamais observés |

- Chaînes `type` exactes : `<slug>:ready`, `<slug>:dirty`, `<slug>:save`. Aucun type non documenté reçu.
- L'hôte a envoyé `host` `{version:"1"}` (et `{version:"1", handoff:true}` pour la question 8) : aucune réaction visible.
- **Lu** (`apps/pdfcraft-web/src/main.rs` au tag `v0.21.1`) : `post_ready(version, false)`,
  `post_save(name, bytes, None, save_as)`, `post_failed` seulement si l'application ne démarre pas, aucun
  `post_handoff`. La bibliothèque commune (`craft-web-host` au commit `fd5e2fe`) sait porter un `id` et un
  `handoff` : c'est l'application qui ne s'en sert pas. Le code de WordCraft n'a pas été lu.
- Les chaînes `handoff`, `handoff-done` et `saveAs` sont présentes dans les deux binaires wasm (lu, `grep`).

## 2. Ouvrir un document

| | PdfCraft | WordCraft |
|---|---|---|
| Contenu affiché | **vérifié** (PDF de 3 pages, captures) | **vérifié** (DOCX de 3 paragraphes, captures, `docInspect().blocks`) |
| Document au démarrage en mode hôte | écran d'accueil, aucun document | aucun document (`docInspect()` répond « no document is open ») |
| Fichier invalide (`invalid.pdf` / `invalid.docx`) | **pas de `failed`**. Notification transitoire « Impossible d'ouvrir invalid.pdf : the file is not a readable PDF… » (lisible par `docInspect().notice`). Le document précédent reste ouvert | **pas de `failed`**. Message dans la barre d'état « Impossible d'ouvrir invalid.docx… » et avertissement console `not a valid zip package` |
| Mauvais format | `.docx` : notification « Office documents open only in the desktop app, which converts them with LibreOffice ». Pas de `failed` | `.pdf` : avertissement console `unsupported format .pdf`. Pas de `failed` |

Conséquence : l'hôte ne sait pas si l'ouverture a réussi. Avec `?control` on peut lire `docInspect()`
(PdfCraft : `documents`, `notice` ; WordCraft : lève une erreur tant qu'aucun document n'est ouvert), sans
`?control` il faut valider le fichier côté serveur avant de l'envoyer.

## 3. Enregistrer

| Action | PdfCraft | WordCraft |
|---|---|---|
| Ctrl+S | **vérifié** (clavier, navigateur intégré et Playwright) : `save {name:"test.pdf", saveAs:false}`, sans `id` | **vérifié** (clavier, Playwright) : `save {name:"test.docx", saveAs:false}`, sans `id` |
| Enregistrer sous | **vérifié** (menu Fichier et `execute`) : `saveAs:true`, **même nom**, aucune boîte de dialogue de nom | **vérifié** (`execute("file.saveAs")`) : `saveAs:true`, même nom, aucune boîte de dialogue |
| Export | **vérifié** : `export.docx` et `export.text` produisent un **téléchargement du navigateur** (`test.docx`, `test.txt`), aucun message à l'hôte. `export.text`/`export.image` ouvrent d'abord une boîte de dialogue d'options | **vérifié** : `file.exportPdf` → `save {name:"test.pdf", saveAs:false}` ; `file.exportPng` → `save {name:"test.png", saveAs:false}` |
| `dirty:false` après `saved` | sans objet : jamais d'`id`, donc jamais de `saved` | idem |
| Sans `saved`, reste « modifié » ? | **non** : `dirty:false` arrive entre 10 ms et 1 s après le `save`, que le stockage réponde 201 ou 500 (essai « stockage en échec ») | **non**, idem ; le titre affiche « test — Enregistré » alors que le stockage a répondu 500 |

« Enregistrer sous » ne demande pas de nom dans le navigateur : si on veut un autre nom, c'est l'hôte qui le demande.

## 4. Même fichier réenregistré deux fois

**Vérifié** (`execute("file.save")` deux fois sans modification entre les deux).

- Les deux renvoient un second `save`, **sans `id`** dans les deux cas : la question « même `id` ou nouveau » n'a pas d'objet.
- PdfCraft : octets identiques (même SHA-256).
- WordCraft : octets différents (6 617 puis 6 620 octets) sans modification du contenu. Cause **non vérifiée**
  (probablement une date ou un numéro de révision dans le paquet DOCX).
- Un enregistrement sur un document non modifié produit quand même un `save` : la sauvegarde automatique ne doit
  déclencher `file.save` que si le document est modifié.

## 5. Gros fichiers

- `ready.file` vaut `false` pour les deux : **vérifié**. Envoyer `{name, file, size}` quand même :
  PdfCraft ignore le fichier avec l'avertissement console « host file test.pdf came as a File; PdfCraft reads bytes only; not opened » ;
  WordCraft ne l'ouvre pas, sans message. Aucun des deux n'envoie `failed`. **Vérifié.**
- Le mode `Blob` n'est donc pas mesurable ; mesures avec `bytes` uniquement (Chrome sans écran, mémoire privée Windows des processus Chrome) :

| | Fichier | Mémoire linéaire wasm avant → après | Processus de rendu (privé) avant → pic → +25 s | Ouvert en |
|---|---|---|---|---|
| PdfCraft | PDF de 100,0 Mo, 50 pages | 30 → 125 Mio | 149 → 356 → 257 Mio | moins de 3 s |
| WordCraft | DOCX de 40,0 Mo (une image PNG de 3 650 × 3 650) | 25 → 367 Mio | 318 → 513 Mio | moins de 3 s |

- La mémoire linéaire du wasm ne redescend pas (c'est le fonctionnement normal de WebAssembly).
- WordCraft occupe déjà environ 320 Mio sans document, PdfCraft environ 150 Mio.
- La limite de 512 Mio côté application n'a **pas** été testée.
- Pour WordCraft, le DOCX de 40 Mo est le plus gros fichier raisonnable fabriqué ici (image non compressible) ;
  un DOCX réel de cette taille serait surtout composé d'images, comme celui-ci.

## 6. `?control` et sauvegarde automatique

| | PdfCraft | WordCraft |
|---|---|---|
| `window.<slug>` sans `?control` | absent (c'est le `<canvas id="pdfcraft">`, sans fonctions) | **présent avec toutes les fonctions** (comme l'annonce son `HOSTING.md`) |
| Avec `?control` | `request`, `execute`, `commands`, `docInspect`, `uiInspect`, `screenshot` | idem |
| Forme de `commands()` | `{commands:[{id,label,menu,shortcut,enabled}]}`, 224 commandes | tableau `[{id,label,location,params,shortcut,enabled}]`, 675 commandes |
| Commande Enregistrer | `file.save` (Enregistrer sous : `file.save_as`) | `file.save` (Enregistrer sous : `file.saveAs`) |
| Retour de `execute("file.save")` | `{"ran":"file.save"}` | `{"bytes":6617,"downloaded":"test.docx"}` |
| Effet | `save` immédiat (≤ 10 ms), aucune boîte de dialogue | idem |

- **Vérifié** : après `execute("file.save")`, la sélection (WordCraft), la page, le zoom, l'outil, le mode
  (PdfCraft) et le focus clavier sont inchangés ; la frappe continue normalement juste après.
- **Vérifié** (navigateur intégré masqué) : un onglet caché ne répond pas : `commands()` a échoué au bout de 30 s
  avec « pdfcraft did not answer ui.commands within 30 s (a hidden tab answers when it is shown again) ».
  Une sauvegarde automatique pilotée par minuterie ne part donc pas quand l'onglet est en arrière-plan.
  Le README précise qu'une requête expirée peut quand même s'exécuter plus tard.
- **Vérifié** : la sauvegarde automatique native de WordCraft (`file.autosave`, interrupteur dans la barre)
  refuse de s'activer dans le navigateur : « L'enregistrement automatique n'est pas disponible dans le navigateur ».
- PdfCraft ne propose pas de commande d'enregistrement automatique (liste `commands()`).

## 7. CSP

**Vérifié** avec les deux applications : ouverture, modification, enregistrement ; pour PdfCraft, OCR
(`ocr.recognize`, option « Forcer l'OCR ») : chargeur de worker demandé deux fois, `models/*.onnx`, `*_loader.js`, `.js`,
`_bg.wasm` chargés sans violation. Le résultat de l'OCR lui-même n'a pas été contrôlé.

Politique de départ : les deux applications ne démarrent pas (pas de `ready` en 25 s) :

```
Executing inline script violates the following Content Security Policy directive 'script-src 'self' 'wasm-unsafe-eval''. Either the 'unsafe-inline' keyword, a hash ('sha256-DcIrCr8IZg9N1yHRr4c+Yz2tU8EO8pojr6RenAIhOCY='), or a nonce ('nonce-...') is required…
Applying inline style violates the following Content Security Policy directive 'default-src 'self''. … a hash ('sha256-LP5wW9+6blEd+MllZJTg1sH5bA+xZIiFY5q+vHTAJNA=') …
```

Cause : `index.html` (généré par trunk) contient un `<script type="module">` et un `<style>` en ligne.

Politique la plus stricte qui fonctionne (les empreintes changent à chaque version : le serveur les calcule
au démarrage depuis `index.html`, mode `CSP=auto` par défaut dans `server.js`) :

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'sha256-<script en ligne>';
style-src 'self' 'sha256-<style en ligne>'; worker-src 'self'; img-src 'self'; connect-src 'self';
font-src 'self'; frame-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none';
object-src 'none'; frame-ancestors 'self'
```

Empreintes pour ces versions : PdfCraft script `sha256-DcIrCr8IZg9N1yHRr4c+Yz2tU8EO8pojr6RenAIhOCY=`, style
`sha256-LP5wW9+6blEd+MllZJTg1sH5bA+xZIiFY5q+vHTAJNA=` ; WordCraft script
`sha256-uT4pEsEr7Qc9nu2h763DNoejMQ9XLCuSl2qptrt2dWg=`, style `sha256-IcBydvQ/LvIHu1Hnj80dBF1niTxNsRLzvcaMNRl+lBg=`.

- `blob:` et `data:` ne sont nécessaires ni pour `worker-src` ni pour `img-src` dans ces scénarios.
- `require-trusted-types-for 'script'` casse l'OCR de PdfCraft : « This document requires 'TrustedScriptURL'
  assignment. The action has been blocked. » (les workers ne démarrent plus, seuls les modèles sont chargés).
  Le reste fonctionne. À ne pas mettre.
- **Non vérifié** : insertion d'image, presse-papiers, impression, polices, glisser-déposer.

## 8. Aiguillage (`handoff`)

**Aucun `handoff` observé**, avec `host {handoff:true}` envoyé. Scénarios essayés :

- PdfCraft : ouvrir un `.docx` → refus local (« Office documents open only in the desktop app ») ;
  `export.docx` → téléchargement du navigateur, pas de `handoff`.
- WordCraft : ouvrir un `.pdf` → refus local (`unsupported format .pdf`).
- Non essayé : « Joindre un fichier » (`edit.attach`), « Insérer des pages depuis un fichier » (`page.insert`),
  « Images » (`insert.picture`) : ils ouvrent le sélecteur de fichiers du navigateur, que l'hôte ne peut pas alimenter.

**Lu** : PdfCraft 0.21.1 n'appelle jamais `post_handoff`. Pas de scénario simple trouvé : l'aiguillage
reste à prévoir mais pas à construire tant qu'une application ne l'émet pas.

## 9. Poids et temps

**Vérifié**, mesuré par le serveur (corps des réponses) avec un cache navigateur vide, sur `localhost` :

| | Zip | Décompressé | wasm brut | Transféré au chargement (Brotli 9 à la volée) | `ready` après `src` de l'iframe |
|---|---|---|---|---|---|
| PdfCraft | 34,4 Mo | 62 Mo | 60,6 Mo | 16,21 Mo (dont wasm 16,19) | 375 à 436 ms |
| WordCraft | 22,5 Mo | 59 Mo | 61,0 Mo | 15,64 Mo (dont wasm 15,61) | 516 à 576 ms |

Compression du wasm, mesurée (taille / temps CPU sur cette machine) :

| | gzip 9 | Brotli 5 | Brotli 9 | Brotli 11 |
|---|---|---|---|---|
| PdfCraft | 21,97 Mo / 1,5 s | 17,23 Mo / 1,2 s | 16,19 Mo / 7,8 s | 13,65 Mo / 149 s |
| WordCraft | 22,56 Mo / 1,4 s | 16,49 Mo / 1,0 s | 15,61 Mo / 5,5 s | 13,10 Mo / 121 s |

- Premier chargement après démarrage du serveur : 6,2 à 6,6 s jusqu'à `ready`, car le serveur compresse le wasm
  à la volée. Il faut **précompresser au build** (Brotli 11 + gzip) et servir les fichiers `.br`/`.gz`.
- OCR de PdfCraft, au premier usage : worker 3,4 Mo (0,82 Mo en Brotli), modèles 12,2 Mo **incompressibles**
  (`.onnx`, gain < 1 %).
- Les temps sur `localhost` ne disent rien du réseau : à 50 Mbit/s, 13 Mo prennent environ 2 s (calcul, non mesuré).

## 10. Différences PdfCraft / WordCraft

| Sujet | PdfCraft 0.21.1 | WordCraft 0.18.1 |
|---|---|---|
| `dirty` après `ready` | non | `dirty:false` spontané |
| `window.<slug>` | seulement avec `?control` | toujours |
| `commands()` | objet `{commands:[…]}`, ids `snake_case` (`file.save_as`) | tableau, ids `camelCase` (`file.saveAs`) |
| Exports | téléchargement du navigateur (contourne l'hôte) | `save` à l'hôte |
| Erreur d'ouverture | notification, lisible par `docInspect().notice` | barre d'état et console |
| Réenregistrement sans modification | octets identiques | octets différents |
| Drapeau `?cpu` | accepté | ignoré (documenté : seulement `?webgl`) |
| Journal console | silencieux | journalise le moteur de rendu, les avertissements egui |
| Mémoire sans document | environ 150 Mio | environ 320 Mio |

## 11. Tests automatiques

**Vérifié** : Chrome sans écran piloté par Playwright charge les deux applications.

- Moteur de rendu observé : WebGPU par défaut (WordCraft journalise `wgpu backend BrowserWebGpu`) ; `?webgl` →
  WebGL ; avec `--disable-gpu` (cas d'une CI sans GPU) les deux démarrent quand même en rendu logiciel
  (« Software rasterizer detected… ANGLE »). `?cpu` fonctionne pour PdfCraft, WordCraft l'ignore.
- Test écrit : `e2e/apps.e2e.mjs` (`npm run test:e2e`), passé en mode sans écran et avec écran (`HEADED=1`) :
  CSP stricte du serveur ; `ready` (`version:"1"`, `appVersion` = version de `apps.json`) ; `open` ; modification
  par `execute` ; **Ctrl+S au clavier** ; `save` stocké (201) ; `dirty:false` ; rechargement de la page hôte ;
  réouverture depuis `GET /api/echo/:id` ; la modification est là ; même SHA-256 ; aucune violation de CSP.
  Le test vérifie aussi l'absence d'`id` : il cassera si une prochaine version en envoie un.
- Un passage du test PdfCraft a échoué une fois (101 s, cause non établie : charge machine ou double compression
  du wasm, corrigée depuis) ; quatre passages suivants ont réussi.
- Le test ignore une application si `vendor/` ou le navigateur manquent (`PW_CHROMIUM` pour choisir le binaire).

## Autres constats

- **Releases** : chaque release publie `SHA256SUMS.txt`, sa signature `SHA256SUMS.txt.asc`, une clé
  `release-signing-key.asc`, et GitHub donne l'empreinte de chaque fichier. `fetch-app.mjs` vérifie
  `SHA256SUMS.txt` **et** l'empreinte GitHub ; la signature GPG n'est **pas** vérifiée.
- Le zip contient un dossier racine `<slug>-web-<version>/`, retiré à la décompression (`stripPrefix` dans `apps.json`).
- Le zip contient `_headers`, `.htaccess`, `README.md`, `HOSTING.md`, licences : servis ou non selon la règle
  « pas de fichier caché » (`.htaccess` → 404). `HOSTING.md` est la doc à jour, plus précise que le README du dépôt.
- PdfCraft accepte `?file=<URL>` pour ouvrir un document au démarrage, et les deux acceptent `?author=` (nom
  des commentaires et suivis de modifications) : utile pour passer le nom du compte.
- `integrity` sur les `<link rel=preload>` : avertissement Chrome sans conséquence.
- `vendor/` est **intact** après tous les essais : `scripts/verify-vendor.mjs` recalcule le SHA-256 de chaque
  fichier et le compare au manifeste écrit à la décompression (45 fichiers, 0 écart).

## Thème des applications (constat du 14/11/2026)

- **Vérifié** (Chrome, système en sombre, page en clair) : l'application dans l'iframe suit `prefers-color-scheme` du
  **système** ; la propriété CSS `color-scheme` posée sur l'iframe par la page hôte n'a aucun effet.
- Les deux applications ont une commande de thème : PdfCraft `view.theme.light` / `.dark` / `.system`, WordCraft
  `view.interfaceTheme {value: "light"|"dark"|"system"}`. **Vérifié** : WordCraft applique le thème du compte via
  `window.wordcraft` (toujours présent), mais refuse la commande tant qu'aucun document n'est ouvert (« Aucun document
  n'est ouvert ») ; la page hôte réessaie. PdfCraft l'applique aussi, mais seulement avec `?control` (non activé par défaut).

## Non vérifié

- Firefox et Safari.
- Limite de 512 Mio et coupure du nom à 255 caractères.
- Résultat réel de l'OCR (le traitement démarre, la sortie n'a pas été lue).
- Comportement dans un vrai déploiement HTTPS derrière Traefik et Cloudflare (tout s'est fait en `http://localhost`).
- Signature GPG des releases.
- Code source de WordCraft (seul celui de PdfCraft a été lu pour le pont).
