# Plan de mise en œuvre : craft-host

Complète `CLAUDE.md` (décisions, contrat de messages, règles) et `PHASE0.md` (mission du prototype).
Établi le 13 novembre 2026 à partir de la lecture de `storytold/pdfcraft` (commit `ec31c55`), `storytold/craft-libs`
(commit `75c70fa`), `PetitOursManu/Mocky` (commit `bb6cc99`) et des README `packaging/web` de WordCraft et PhotoCraft.
Version initiale : tout venait de la lecture du code et des README. **Mis à jour le 13 novembre 2026 après la
phase 0** (`FINDINGS.md`, PdfCraft 0.21.1 et WordCraft 0.18.1) : les points vérifiés sont marqués « (vérifié) »,
les corrections « (corrigé par la phase 0) ».

## 1. Ce que le dépôt PdfCraft permet réellement

- La version web est un site statique sans code serveur. Sans hôte, « Enregistrer » est un téléchargement du navigateur
  (fonction `download` dans `crates/ui-egui/src/editing/save.rs`).
- Mode hôte documenté dans `packaging/web/README.md` : iframe de même origine (`?host=parent`, `postMessage`) ou même
  document (`data-host="page"`, événements sur le canvas `id="pdfcraft"`). Dans ce mode, l'application remet les octets
  du PDF à la page, qui décide où ils vont (vérifié pour Enregistrer et Enregistrer sous). **Corrigé par la phase 0 :
  les exports (Word, texte, image…) restent des téléchargements du navigateur**, ils ne passent pas par l'hôte.
- `?control` ajoute `window.pdfcraft` (`request`, `execute`, `commands`, `docInspect`, `uiInspect`, `screenshot`) (vérifié).
  `file.save` et `file.save_as` confirmés par `commands()` (vérifié).
- Le zip contient `HOSTING.md`, la doc d'hébergement à jour de la version : c'est elle qu'il faut lire à chaque mise à jour.
- Limites annoncées : 512 Mio à l'ouverture par l'hôte, nom coupé à 255 caractères, fichiers de l'hôte traités comme non fiables.
- Licence MIT ou Apache-2.0. Les logos ArtCraft ne peuvent servir qu'inchangés et avec PdfCraft : le zip officiel intact respecte cette règle.
- Le projet est en alpha (créé fin septembre 2026) : épingler les versions et rejouer le prototype à chaque mise à jour.

## 2. Catalogue

- 17 applications sur https://getartcraft.com/apps, 16 avec version web (FilmCraft n'en a pas). Cinq en alpha précoce
  (PhotoCraft, PdfCraft, AniCraft, FigCraft, Craft Anything), douze en développement.
- Dépôts publics `github.com/storytold/<slug>` pour : photocraft, vectorcraft, lightcraft, effectcraft, anicraft, designcraft,
  figcraft, texturecraft, materialcraft, soundcraft, wordcraft, deckcraft, cadcraft, gridcraft, craft-anything, filmcraft.
- **Vérifiés en phase 0** : PdfCraft 0.21.1 et WordCraft 0.18.1 (zip, mode hôte, enregistrement, CSP, test e2e).
  Différences entre les deux : voir `FINDINGS.md` § 10 (notamment `window.wordcraft` toujours exposé).
  PhotoCraft s'emballe autrement (lu) : wasm de 24 Mio avant compression, découpé en morceaux de 20 Mio au plus, Dockerfile
  et `nginx.conf` propres, mode hôte non mentionné dans le README. **Les 14 autres ne sont pas vérifiés.**
- Noms des fichiers de release (vérifié pour PdfCraft et WordCraft) : `<slug>-web-<version>.zip`, avec `SHA256SUMS.txt`,
  sa signature `.asc` et l'empreinte de l'asset dans l'API GitHub. Le zip contient un dossier racine `<slug>-web-<version>/`.

## 3. Architecture

Un service Node/Express derrière Traefik dans Coolify, un volume `/data`. Zips officiels dans `vendor/<slug>/<version>/`,
servis en statique après vérification de la session.

| Brique | Rôle |
| --- | --- |
| Page de connexion | Affichée avant tout chargement d'application (wasm de 61 Mo, 13 Mo en Brotli 11 : vérifié) |
| « Mes documents » | Liste, envoi, renommage, suppression, espace utilisé, « Ouvrir avec… » |
| Page hôte | Charge l'application choisie, lui envoie le document (`<slug>:open`), reçoit les octets (`<slug>:save`) et les envoie à l'API |
| API fichiers | Routes authentifiées, propriétaire vérifié à chaque appel, quotas |
| Stockage | SQLite (comptes, sessions, métadonnées) + fichiers sur disque sous des UUID |
| Registre d'applications | `apps.json` : identifiant, nom, version épinglée, dossier, extensions acceptées, taille maximale, mode (iframe ou page), activée ou non |

Choix : **iframe de même origine** (`?host=parent`) plutôt que le mode « même document », car d'après le README l'application ne
répond alors qu'à la fenêtre parente, alors que dans l'autre mode tout script de la page peut la piloter. Le format exact des
messages est dans le contrat `craft-web-host` (résumé dans `CLAUDE.md`, avec le comportement réel vérifié). L'iframe de même
origine fonctionne pour les deux applications (vérifié), y compris avec une CSP stricte.

Multi-applications : un chemin par application (`/apps/<slug>/`), une seule origine (avec un parent d'une autre origine,
l'application tourne comme si elle n'était pas encadrée), ouverture d'un document par l'application choisie d'après l'extension,
aiguillage sur `handoff` (l'hôte range le fichier, l'ouvre dans l'application qui l'édite, répond `handoff-done`), droits
d'application par compte, un dossier par application et par version avec un script de mise à jour.

## 4. Connexion : ce qu'on reprend de Mocky

Lire `PetitOursManu/Mocky` : `server/index.js` (hachage ~l.437, sessions ~l.816, `/api/login` ~l.1096), `server/auth-lockout.js`,
`server/storage-quota.js`, `deploy/fail2ban/mocky.conf`.

| Élément | Dans Mocky | Décision |
| --- | --- | --- |
| Mot de passe | scrypt de Node, sel de 16 octets, comparaison en temps constant, 8 caractères minimum | Reprendre avec les corrections 1 et 2 |
| Session | Jeton aléatoire en cookie `httpOnly`, `sameSite: lax`, `secure` selon HTTPS, expiration glissante de 90 jours | Reprendre avec la correction 3 |
| Fin de session | Toutes les sessions d'un compte révoquées au changement de mot de passe | Reprendre tel quel |
| Limites de tentatives | 8 essais par minute et par IP + verrouillage du compte après 10 échecs pendant 15 minutes (`auth-lockout.js`, 72 lignes, avec tests) | Reprendre tel quel, avec la correction 4 |
| Comptes | Le premier compte devient admin, puis l'inscription publique se ferme ; l'admin crée les autres, avec changement de mot de passe forcé | Reprendre tel quel |
| Journal | Une ligne par événement de connexion au format fail2ban + journal d'audit | Reprendre tel quel |
| Quota disque | Plafond global suivi en mémoire | Adapter en quota par utilisateur, suivi en base |
| En-têtes | `nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, HSTS sous HTTPS, pas de CSP | Reprendre avec la correction 6 |
| SSO Dashy | Jeton HS256 de 60 secondes, audience vérifiée, usage unique (`jti`) | Optionnel, phase 6 |

Les 6 corrections (détail dans `CLAUDE.md`) : scrypt asynchrone et plus coûteux ; faux hachage quand le nom n'existe pas ;
jetons de session hachés (SHA-256) ; `TRUST_PROXY` correct derrière Cloudflare + Traefik ; contrôle `Origin` / `Sec-Fetch-Site`
sur les requêtes modifiantes ; CSP testée (`worker-src 'self'`, probablement `'wasm-unsafe-eval'`).
Constat de lecture : je n'ai trouvé dans Mocky ni jeton CSRF ni contrôle d'origine, tout repose sur `sameSite: lax`.
SQLite plutôt que fichiers JSON (Mocky relit `users.json` à chaque requête authentifiée).

## 5. API fichiers

| Route | Usage |
| --- | --- |
| `GET /api/files` | Liste des documents du compte, avec taille, date, application |
| `POST /api/files` | Envoi (corps binaire, nom en en-tête) |
| `GET /api/files/:id` | Lecture des octets |
| `PUT /api/files/:id` | Remplacement par l'enregistrement de l'application (version précédente conservée) |
| `PATCH /api/files/:id` | Renommage |
| `DELETE /api/files/:id` | Suppression |
| `GET /api/files/:id/versions` | Anciennes versions, avec restauration |

Règles obligatoires :

- Aucun nom fourni par l'utilisateur sur le disque (UUID ; le nom affiché vit en base) : supprime le path traversal.
- Propriétaire vérifié à chaque appel ; un fichier d'autrui répond 404, pas 403.
- Validation à l'envoi par type : octets d'en-tête quand le format en a (`%PDF-` pour un PDF), sinon extension ; liste d'extensions par
  application dans le registre ; taille maximale par application ; nombre de fichiers par compte.
- Quota par utilisateur suivi en base ; une écriture qui échoue renvoie une erreur visible (Mocky documente le problème inverse :
  un disque plein qui fait échouer les écritures en silence).
- Écriture atomique : fichier temporaire puis renommage.
- Réponses : `Content-Type` correct, `X-Content-Type-Options: nosniff`, `Content-Disposition` explicite, jamais de service direct du dossier de données.
- Journal d'audit (connexion, envoi, enregistrement, suppression, compte concerné).
- Sauvegarde du volume `/data` dans les sauvegardes du VPS.
- Gros fichiers : `ready.file` vaut `false` pour PdfCraft et WordCraft (vérifié) : envoyer `bytes`. Garder le code `Blob`
  (`{ name, file, size }`) pour une application qui annoncerait `file: true`. Mémoire mesurée : PDF de 100 Mo → +95 Mio de
  mémoire wasm ; DOCX de 40 Mo (image) → +342 Mio. Prévoir une taille maximale par application plus basse que 512 Mio.
- **Validation avant `open` (corrigé par la phase 0)** : les applications n'envoient pas `failed` pour un fichier refusé. Le
  serveur vérifie le type (octets d'en-tête) à l'envoi ; la page hôte, avec `?control`, peut lire `docInspect()` après l'`open`.
- Accusé `saved` : envoyé (avec l'`id` du `save`) uniquement après une réponse 2xx de l'API. **Corrigé par la phase 0 : aucune
  des deux applications n'envoie d'`id`, et elles passent à `dirty:false` dès le `save`, même si le stockage échoue.** La page
  hôte garde donc son propre état : `nonEnregistré = dirty de l'application OU dernier save non stocké`. En cas d'échec :
  bandeau d'erreur, nouvel essai, avertissement avant de quitter. Le code `saved` reste en place pour une future version.
- Enregistrer sous : aucune des deux n'affiche de boîte de nom dans le navigateur (`saveAs:true`, même nom) : la page hôte
  demande le nom et crée un nouveau fichier.
- Exports PdfCraft : téléchargements du navigateur, hors stockage (voir § 6).
- Sauvegarde automatique (**vérifiée** pour les deux) : sur `dirty:true`, minuterie (par exemple 30 s sans nouveau `dirty`),
  puis `execute("file.save")` via `window.<app>` ; pas de boîte de dialogue, sélection et focus conservés. Ne la déclencher que si
  le document est modifié (un document propre produit quand même un `save`). Limite : un onglet masqué ne répond qu'une fois
  visible ; le déclencher aussi sur `visibilitychange` (au retour) et compter sur l'avertissement avant de quitter.
  WordCraft refuse sa propre sauvegarde automatique dans le navigateur (vérifié).

## 6. Sécurité propre au multi-applications

- Toutes les applications partagent l'origine du site. Le README exige `allow-same-origin` dans une iframe isolée (sinon plus de stockage),
  donc aucune isolation réelle entre elles : une faille dans une application qui ouvre un fichier piégé pourrait appeler l'API avec la session
  de la personne. Le cookie `httpOnly` empêche de voler le jeton, pas de s'en servir, et le contrôle d'origine ne bloque pas un appel de même origine.
- Parades : zips officiels non modifiés et épinglés (empreinte SHA-256 vérifiée quand la release en publie une) ; versions de fichiers conservées ;
  limites de débit de l'API par compte ; journal ; ne donner à chaque compte que les applications utiles.
- `?control` / `window.<app>` : tout script de la même origine peut piloter l'application (README de `craft-web-api`). Ne l'activer que pour la
  sauvegarde automatique, pas par défaut. **WordCraft l'expose toujours** (vérifié) : on ne peut pas le désactiver ; c'est un argument de plus
  pour ne donner à chaque compte que les applications utiles.
- Téléchargements : les exports de PdfCraft partent en téléchargement direct (vérifié), hors quotas et hors journal. Une iframe
  `sandbox` sans `allow-downloads` les bloquerait, mais les exports deviendraient silencieusement inopérants. **Décision à prendre.**
- CSP stricte vérifiée (voir `CLAUDE.md`), empreintes calculées par application et par version au démarrage du serveur.
- Si des documents contenant des données personnelles sont stockés : chiffrement du disque et des sauvegardes à décider avant la mise en service.

## 7. Phases (chacune se termine par un critère vérifiable)

| Phase | Contenu | Critère de fin |
| --- | --- | --- |
| 0. Prototype jetable | `PHASE0.md` | **Fait le 13/11/2026.** Ouvrir, modifier, enregistrer, recharger, retrouver : vérifié pour les deux. `saved` impossible (aucun `id` envoyé). `FINDINGS.md` répond aux 11 questions |
| 1. Squelette serveur | Express + SQLite, comptes, sessions hachées, premier compte admin, verrouillage, limites, journaux fail2ban, tests repris de Mocky | **Fait le 14/11/2026** (`test/auth.test.js`) : connexion/déconnexion, verrouillage, limite par IP, sessions hachées, contrôle d'origine. **Non vérifié** : IP réelle derrière Cloudflare et Traefik (phase 4) |
| 2. API fichiers | Routes, quotas par utilisateur, versions, écriture atomique, audit | **Fait le 14/11/2026** (`test/files.test.js`) : propriétaire (404), noms, signature, quota, taille, versions élaguées, dossiers, suppression des octets. Interruption d'écriture : seulement le nettoyage du temporaire |
| 3. Interface | Connexion, « Mes documents », page hôte (état « non enregistré » tenu par l'hôte, sauvegarde automatique), avertissement avant de quitter | **Fait le 14/11/2026** (`e2e/apps.e2e.mjs`, Chrome) : connexion, explorateur, double-clic, Ctrl+S, nouvelle version, rechargement, alerte d'échec et réessai, invité. Sauvegarde automatique : pas encore |
| 4. Déploiement Coolify | Dockerfile (Node + dossiers des zips **précompressés en Brotli 11 et gzip au build**), volume `/data`, domaine, limites CPU et mémoire, sauvegarde du volume | Redémarrage sans perte ; restauration depuis la sauvegarde essayée |
| 5. Exploitation | Script de mise à jour d'une application, règle fail2ban, création de comptes par l'admin | Mise à jour d'une application sans toucher au code ni perdre de session |
| 6. Options | SSO Dashy, double authentification, partage d'un document | À décider après usage réel |

Ajouter une application au catalogue (à refaire pour chacune, FilmCraft exclu) : lire son `packaging/web/README.md` et confirmer
zip web + mode hôte ; entrée dans `apps.json` ; prototype (ouvrir, modifier, enregistrer, `saved`, recharger, `handoff` si pertinent) ;
mesurer poids et mémoire ; activer pour les comptes concernés. Ordre : PdfCraft, WordCraft, puis le reste.

## 8. Risques

- Format des messages : vérifié pour PdfCraft 0.21.1 et WordCraft 0.18.1. Le contrat prévoit plus (`id`, `saved`, `failed`, `handoff`)
  que ce que les applications envoient : une mise à jour peut changer le comportement. Le test e2e casse volontairement si un `id` apparaît.
- Sauvegarde automatique via `window.<app>` : vérifiée, sauf onglet masqué (pas de réponse tant qu'il n'est pas visible).
- Échec de stockage invisible pour l'application (elle se croit enregistrée) : l'hôte doit l'afficher lui-même.
- Maturité : douze applications « en développement », cinq en alpha précoce ; une version web peut exister sans être utilisable.
- Emballages hétérogènes : PhotoCraft découpe son wasm et son README met en garde contre les hôtes qui répondent `index.html` à tout chemin
  inconnu : répondre 404 aux fichiers absents.
- Licences : seule celle de PdfCraft (MIT ou Apache-2.0) est connue. Lire celle de chaque application et ses conditions de
  redistribution avant activation.
- Poids (vérifié) : wasm de 61 Mo pour PdfCraft et WordCraft, 13 Mo en Brotli 11, 16 Mo en Brotli 9 ; + 12 Mo de modèles OCR
  incompressibles au premier OCR de PdfCraft. Mémoire du navigateur : 150 à 320 Mio sans document. 24 Mio avant compression pour
  PhotoCraft (lu). Fichiers hachés en cache long, précompression au build.
- Contrat identique ne veut pas dire comportement identique : une application peut implémenter le pont de façon partielle.
- Préférences des applications dans le `localStorage` de l'iframe : elles ne suivent pas le compte d'un appareil à l'autre (acceptable au départ).
- Service exposé sur Internet : dépendances Node à jour, fail2ban actif, IP réelle vérifiée.
- Tout s'exécute dans le navigateur : charge serveur négligeable (pas de bureau à distance type Selkies, écarté pour son coût CPU et l'absence de comptes séparés).

## 9. Sources lues

- https://getartcraft.com/apps
- https://github.com/storytold/pdfcraft : `packaging/web/README.md`, `crates/ui-egui/src/editing/save.rs`, `apps/pdfcraft-web/src/api.rs`
- https://github.com/storytold/craft-libs : `crates/web-host/README.md`, `crates/web-api/README.md`
- https://github.com/storytold/wordcraft et https://github.com/storytold/photocraft : `packaging/web/README.md`
- https://github.com/PetitOursManu/Mocky : `server/index.js`, `server/auth-lockout.js`, `server/storage-quota.js`
