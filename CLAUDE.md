# craft-host : héberger les applications Craft (ArtCraft) sur mon VPS

## But

Un service Node/Express qui sert plusieurs applications web du catalogue Craft
(https://getartcraft.com/apps) avec une connexion par utilisateur et un stockage
des fichiers sur le serveur. Déploiement : VPS Coolify + Traefik, domaine sous
`*.emanuelvigreux.fr`. Je suis administrateur systèmes et réseaux : je lis le code et les
commandes, inutile de tout expliquer, mais dis-moi clairement ce qui est vérifié et ce qui ne l'est pas.

## Fichiers du dossier

- `CLAUDE.md` (ce fichier) : décisions et règles.
- `PLAN.md` : le plan détaillé (architecture, reprise de Mocky, API fichiers, sécurité, phases, risques, sources).
- `PHASE0.md` : la mission du prototype (terminée).
- `FINDINGS.md` : constats de la phase 0 (PdfCraft 0.21.1, WordCraft 0.18.1). Quand il contredit `PLAN.md` ou ce fichier, il a raison.
- `README.md` : démarrage local.
- Serveur : `server.js` (point d'entrée) et `src/` : `app.js` (assemblage, pages, accès aux applications), `auth.js` (comptes,
  sessions, verrouillage), `files.js` (dossiers, fichiers, versions, quotas), `admin.js`, `static.js` (MIME, compression, CSP),
  `db.js` (schéma SQLite), `log.js` (journal fail2ban + audit). Données dans `DATA_DIR` (défaut `./data`, ignoré par git).
- Logo : source `assets/crafty-logo-source.webp`, déclinaisons dans `public/brand/` (favicon, icônes, manifeste web).
- Interface (`public/`) : `intercept.js` (interceptions dans l'iframe), `login.*`, `index.html` + `explorer.*` (accueil = applications + explorateur de fichiers),
  `host.*` (page hôte de production ; journal et outils seulement pour un admin avec `?debug`), `admin.*`, `ui.*` (composants
  communs), `theme.js` (thème clair par défaut, avant le premier affichage).
- Outils : `scripts/fetch-app.mjs` (+ `unzip.mjs`, `verify-vendor.mjs`), `make-samples.mjs`, `pw.mjs` (Playwright).
  Tests : `test/` (`npm test`, serveur sur fausses applications), `e2e/` (`npm run test:e2e`, vraies applications dans Chrome).

Distingue toujours « vérifié » (exécuté) de « lu dans la doc ». Ce que la phase 0 a vérifié est marqué comme tel ;
le reste de `PLAN.md` vient de lectures.

## Décision d'architecture (à ne pas remettre en cause sans me demander)

- **Aucun fork du code Rust.** Chaque application est le zip web officiel de sa release GitHub
  (`storytold/<app>`, fichier `<app>-web-<version>.zip`), décompressé dans
  `vendor/<slug>/<version>/` et **jamais modifié**. Versions épinglées dans `apps.json`.
- **Une seule origine.** Les applications sont servies sous `/apps/<slug>/` et chargées dans une
  iframe de même origine avec `?host=parent` (ou, décision du 14/11/2026, en **mode interception** pour celles sans pont : voir plus bas). Le pont n'écoute que la fenêtre parente de même
  origine : pas de sous-domaine par application.
- **Le serveur n'exécute aucune application.** Tout tourne dans le navigateur ; le serveur
  authentifie, stocke les fichiers et sert les fichiers statiques.
- Les fichiers de `vendor/` sont des données non fiables : on ne les exécute pas côté serveur,
  on ne les modifie pas, on ne les lit que pour les servir.

## Contrat de messages (craft-web-host, commun à toutes les applications)

Source : https://github.com/storytold/craft-libs/blob/main/crates/web-host/README.md

Avec `?host=parent`, un message est un objet `{ type: "<app>:<kind>", ...champs }` envoyé par
`postMessage` de même origine ; `bytes` est un `ArrayBuffer` transféré.

| Kind | Sens | Champs | Rôle |
|---|---|---|---|
| `ready` | app → hôte | `version`, `appVersion?`, `file?` | l'application peut recevoir un document ; `file: true` = elle lit un `Blob` par tranches |
| `host` | hôte → app | `version`, `handoff?` | ce que l'hôte gère |
| `open` | hôte → app | `name`, et `bytes` ou `file` + `size` | ouvrir un document |
| `save` | app → hôte | `name`, `bytes`, `id?`, `saveAs?` | Enregistrer / Enregistrer sous / Exporter : l'hôte stocke |
| `saved` | hôte → app | `id` | la sauvegarde `id` est stockée, l'application efface « modifié » |
| `dirty` | app → hôte | `dirty` | modifications non enregistrées |
| `failed` | app → hôte | `error`, `id?` | un document ou une sauvegarde n'a pas pu être pris |
| `handoff` | app → hôte | `name`, et `bytes` ou `file` + `size` | ce fichier relève d'une autre application |
| `handoff-done` | hôte → app | `name`, `app` | l'hôte l'a donné à l'application qui l'édite |

Règles : l'hôte vérifie `event.origin === location.origin` et `event.source === iframe.contentWindow`.
L'hôte ne répond `saved` que pour un `save` qui porte un `id`. Une `version` inconnue se traite
comme `"1"`. Limite d'ouverture côté application : 512 Mio, nom coupé à 255 caractères.

**Comportement réel vérifié en phase 0 (PdfCraft 0.21.1, WordCraft 0.18.1)**, à relire à chaque mise à jour :

- `ready` : `version:"1"`, `appVersion`, `file:false` → toujours envoyer `bytes`, jamais de `Blob`.
- `save` ne porte **jamais d'`id`** : pas de `saved`, et l'application passe à `dirty:false` dès le `save` envoyé,
  même si le stockage échoue. **L'hôte tient son propre état « non enregistré »** (dernier `save` non stocké).
- `failed` n'est jamais envoyé pour un fichier refusé : valider le fichier côté serveur avant l'`open`.
- `handoff` jamais émis.
- Exports PdfCraft (Word, texte, image…) = téléchargements du navigateur, hors de l'hôte. Exports WordCraft = `save`.

`?control` ajoute `window.<app>` (crate `craft-web-api`) : tout script de la même origine peut piloter
l'application. **Décision du 14/11/2026 : la page hôte l'active toujours**, pour la sauvegarde automatique et le thème
du compte (risque accepté : les applications partagent déjà l'origine du site). WordCraft expose `window.wordcraft`
de toute façon. `execute("file.save")` enregistre sans boîte de dialogue ni perte de sélection (vérifié), mais un
onglet masqué ne répond qu'une fois visible. Thème : `view.theme.<light|dark|system>` (PdfCraft),
`view.interfaceTheme {value}` (WordCraft, refusé tant qu'aucun document n'est ouvert) ; l'iframe ignore `color-scheme`.
PdfCraft ouvre un second document reçu par `open` dans un onglet en arrière-plan.

**Boîte « Ouvrir » des applications (vérifié le 14/11/2026)** : les deux applications l'ouvrent par `click()` sur un
`<input type="file">` (bibliothèque `rfd`), avec leurs formats dans `accept`. La page hôte remplace ce `click()` sur la
fenêtre de l'iframe (même origine ; aucun fichier de `vendor/` modifié) : le sélecteur Crafty s'ouvre, et les fichiers
choisis ou importés sont remis à l'élément (`DataTransfer` + `change` ; Annuler → `cancel`). Vaut aussi pour « Insérer des
pages », « Images », etc. `rfd` insère un `<style>` constant : son empreinte est autorisée dans `src/static.js`
(`RUNTIME_STYLES`). Formats dans `apps.json` : `extensions` (édités et enregistrés) et `imports` (seulement ouverts),
relevés dans ces `accept`. Un fichier d'un format que l'application ne lit pas n'est jamais envoyé : la page hôte ne
charge pas l'application et propose celles qui le lisent.

## Exigences serveur pour les fichiers statiques (README de chaque application)

- `.wasm` en `application/wasm`, `.js` en `text/javascript`.
- Compression : **précompresser au build** (Brotli 11 + gzip). Mesuré : wasm de 61 Mo → 13,1 à 13,7 Mo en Brotli 11
  (environ 2 min de CPU par fichier), 16 Mo en Brotli 9 à la volée (6 à 8 s de CPU au premier appel). La doc
  (« 13 MB, 5 MB compressé ») est fausse pour ces versions. Modèles OCR `.onnx` (12 Mo) : incompressibles.
- Fichiers au nom haché : `Cache-Control: public, max-age=31536000, immutable`. `index.html` : `no-cache`.
  Fichiers non hachés (modèles OCR) : `no-cache` avec `ETag`.
- **404 pour les fichiers absents, pas de repli vers `index.html`.**
- HTTPS en production (WebGPU et presse-papiers). Pas d'en-têtes COOP/COEP nécessaires.
- CSP vérifiée (OCR compris) : `default-src 'none'; script-src 'self' 'wasm-unsafe-eval' '<sha256 du script en ligne>';
  style-src 'self' '<sha256 du style en ligne>'; worker-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self';
  frame-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'self'`.
  Les empreintes changent à chaque version : le serveur les calcule depuis `index.html`. Pas de Trusted Types (casse l'OCR).
- Drapeaux d'URL de rendu : `?webgl` (forcer WebGL2), `?cpu` (chemin CPU, PdfCraft seulement). Sans GPU, repli logiciel vérifié.

## Règles pour les phases suivantes (à respecter dès le prototype quand c'est pertinent)

- **Fichiers** : sur disque sous un UUID, le nom affiché vit en base. Propriétaire vérifié à chaque appel
  (404, pas 403). Validation du type par application (liste d'extensions dans le registre). Quota par
  utilisateur suivi en base. Écriture atomique (fichier temporaire puis renommage). Versions conservées.
- **Authentification** : reprendre les motifs de `PetitOursManu/Mocky` (`server/index.js`, `server/auth-lockout.js`,
  `server/storage-quota.js`) avec 6 corrections :
  1. `crypto.scrypt` asynchrone et coût plus élevé (régler pour environ 100 ms sur le VPS), pas `scryptSync` ;
  2. comparer toujours contre un faux hachage quand le nom d'utilisateur n'existe pas (pas de différence de temps) ;
  3. stocker l'empreinte SHA-256 des jetons de session, pas le jeton ;
  4. `TRUST_PROXY` réglé pour Cloudflare + Traefik et vérifié avec un vrai essai (sinon la limite par IP est commune à tous) ;
  5. contrôle `Origin` / `Sec-Fetch-Site` sur toute requête qui modifie des données, jamais d'état modifié en `GET` ;
  6. une CSP, testée.
- Données : SQLite (`better-sqlite3`) pour comptes, sessions, métadonnées.
- Accès : le premier compte devient admin ; l'admin ouvre ou non l'inscription publique et le mode invité (sans stockage :
  « Enregistrer » télécharge). Chaque compte a toutes les applications par défaut, ou une liste choisie par l'admin.
  Une application non autorisée répond 404, comme un fichier d'autrui.
- Fichiers : un enregistrement = une nouvelle version du même fichier (pas un nouveau fichier) ; un contenu identique à la
  version courante n'en crée pas ; « Enregistrer sous » et le premier enregistrement d'un nouveau document demandent le nom ;
  un export d'un autre format va à côté, en demandant avant de remplacer. Un `save` dont le nom diffère du document ouvert
  (autre document ouvert dans l'application elle-même) n'écrase jamais le fichier : « Enregistrer sous ».
- Sauvegarde automatique : après `autosave_seconds` (réglage admin, 30 s par défaut, 0 = désactivée) suivant un `dirty:true`,
  documents déjà stockés seulement. Les sauvegardes automatiques successives remplacent une seule version « auto » ;
  seuls les enregistrements explicites ajoutent des versions.
- Réglages des applications par compte : la page hôte remet dans le `localStorage` les `prefKeys` du compte (table `prefs`)
  avant de charger l'application et renvoie les clés modifiées (10 s, arrière-plan, sortie) ; déconnexion = clés effacées ;
  jamais les réglages d'un autre compte (marqueur `craft-prefs-sync`). Les applications écrivent leurs réglages ~30 s après.
- Données des applications par compte (décision du 15/11/2026) : ce qu'une application garde dans le navigateur au-delà des
  réglages (`data` dans `apps.json` : clés `local`, bases `idb`, fichiers `opfs` avec « dossier/ » et « début* », `clear` = effacé sans
  être copié) suit le compte : instantané opaque par compte et par application (`DATA_DIR/appdata/`, table `app_data`, compté dans
  le quota, 512 Mio au plus), remis avant le chargement, renvoyé toutes les 30 s / en arrière-plan / après chaque enregistrement
  s'il a changé ; données d'un autre compte effacées avant tout chargement (marqueur `craft-data-sync`) ; déconnexion = dernier envoi
  puis effacement (gardées si l'envoi échoue). Relevé par application dans `FINDINGS.md`.
- Assistant IA (décision du 15/11/2026, `src/ai.js`, `public/agent.js`) : bouton « Assistant » sur l'accueil et dans la barre de chaque
  application. Le serveur relaie vers un fournisseur au dialecte OpenAI (/chat/completions avec outils) : OpenRouter, OpenAI,
  Anthropic, Gemini, Mistral, DeepSeek, xAI, Groq, Ollama, compatible (presets repris de Mocky) ; par fournisseur : adresse, clé
  (chiffrée si `CRAFTY_SECRET`, jamais renvoyée au navigateur), modèle, effort (auto/off/low/medium/high, traduit comme dans Mocky).
  L'admin active l'assistant, choisit les comptes (admins toujours), le fournisseur par défaut, les limites (échanges/heure, étapes) ;
  l'utilisateur choisit parmi les fournisseurs prêts. Les outils s'exécutent dans la page (accueil : `explorer-agent.js` ; application :
  `host-agent.js`, commandes de `window.<app>`) ; message système composé par le serveur ; suppressions confirmées par un clic ;
  applications sans API : agent limité (enregistrer, renommer, répondre). Conversations non stockées ; consommation par compte
  (table `ai_usage`).
- Outils de la barre du haut par application : `tools` dans `apps.json` : `calculator`, `converter` (unités), `colors` (bouton « Pipette » : HEX/RVB/TSL/CMJN,
  pipette EyeDropper, contraste) ; un seul panneau ouvert ; rien n'est envoyé au serveur.
- Corbeille (15/11/2026) : supprimer = `deleted_at` (+ `trash_root` pour l'entrée choisie ; le contenu d'un dossier part et revient
  avec lui) ; noms uniques seulement hors corbeille (index partiels) ; restauration à sa place, sinon à la racine, nom changé si pris ;
  effacement définitif à la main ou après `trash_days` (réglage admin, 30 j, 0 = pas de corbeille) ; compte dans le quota.
  L'accueil supprime sans confirmation avec « Annuler » ; l'assistant demande toujours confirmation.
- Favoris et récents (tables `favorites`, `recents`) : accès rapide de l'accueil ; un fichier ouvert ou enregistré dans une
  application devient récent.
- Partage (`src/shares.js`) : lien `/s/<jeton>` vers la version courante d'un fichier, sans compte ; jeton montré une fois (base :
  SHA-256), expiration (1 h à sans limite), révocable, coupé par la corbeille, un compte désactivé ou `sharing_enabled` ; aperçu en
  ligne seulement pour images, PDF et texte (jamais HTML ni SVG), en-têtes noindex / no-referrer / CSP sandbox ; débit limité.
- Miniatures (`/api/files/:id/thumb`, version courante) : images faites par l'accueil ; documents rendus par l'application
  (`control.thumb` : DeckCraft `file.render`, CadCraft `preview`, VectorCraft `document.serialize` png). La copie directe du canvas
  WebGPU donne une image vide (vérifié) et `screenshot()` capture toute l'interface : pas de miniature pour les autres.
- Couleurs des applications : fond de leur icône officielle (getartcraft.com), mesuré ; jamais inventées.
- Direction artistique (refonte du 16/11/2026, maquette Mocky « Crafty — refonte ») : jetons en tête de `public/ui.css` (violet
  `#6D4AFF`, encre `#17142B`, fond lavande ; sombre indigo), barre du haut en verre dépoli, aurore animée (`body.aurora`), boutons
  en pilule, tuiles d'application en dégradé de leur couleur (`--app`, posée par `appTile`), apparitions décalées (`--i`). Pas de
  rebond (`--ease`). `prefers-reduced-motion` coupe toute animation. CSP : pas d'attribut `style` ni d'image `data:` (CSSOM et
  fichiers de `public/img/`).
- Langue (15/11/2026) : français ou anglais selon la langue du navigateur (`navigator.languages[0]` commence par `fr` →
  français, sinon anglais). Le français est la source : `t('texte français {x}', { x })` (`public/i18n.js`), dictionnaires
  `public/i18n/en-*.js` ; pages : `data-i18n` / `data-i18n-attr` traduits par `translateDom()` (`theme.js` masque la page
  jusque-là). Serveur : `src/i18n.js` traduit le champ `error` des réponses selon `Accept-Language` (français sans en-tête ou
  avec `*`, ce qu'envoie `fetch` de Node), textes exacts et motifs dans `src/i18n-en.js`. `test/i18n.test.js` vérifie que chaque
  texte a sa traduction avec les mêmes variables : jamais de `t(\`…${x}…\`)`. Restent en français : journal `?debug`, textes
  destinés au modèle d'IA (descriptions d'outils). Playwright : contexte `fr-FR` par défaut (`scripts/pw.mjs`).
- Production : aucun outil de débogage visible ; journal des messages et « simuler un échec » seulement pour un admin avec `?debug`.
- Le premier compte devient admin puis l'inscription publique se ferme ; l'admin crée les autres comptes
  (changement de mot de passe forcé) et active les applications compte par compte.
- Journal d'une ligne par événement de connexion (format compatible fail2ban) + journal d'audit.

## Conventions

- Node 22 ou plus, ESM, tests avec `node:test`, le moins de dépendances possible.
- Réponds-moi en français. Commits courts et cohérents.
- Ne publie rien et n'expose aucun port en dehors de `localhost` sans me demander.

## Feuille de route (phases 0 à 3 faites le 14/11/2026 ; phase 4 à venir)

0. Prototype jetable : PdfCraft puis WordCraft dans une page hôte, avec relevé des comportements réels (`PHASE0.md`, `FINDINGS.md`). **Fait.**
1. Squelette serveur : comptes, sessions, verrouillage, limites, journaux. **Fait** (inscription ouvrable par l'admin, mode invité).
2. API fichiers : routes, quotas, versions, audit. **Fait** (dossiers, 10 versions par défaut, dernière application par fichier).
3. Interface : connexion, explorateur de fichiers (accueil), page hôte, administration, thème clair/sombre. **Fait.**
   Sauvegarde automatique et thème des deux applications : **faits** (`?control` toujours actif). Reste ouvert :
   `TRUST_PROXY` vérifié en vrai (phase 4).
4. Déploiement Coolify : Dockerfile, volume `/data`, domaine, sauvegarde, limites CPU/mémoire.
5. Exploitation : script de mise à jour d'une application, fail2ban, comptes.
6. Options : SSO avec Dashy, double authentification, partage.

Ajouter une application = `npm run fetch <slug>` (ou `<propriétaire>/<slug>` hors de `storytold` : MailCraft, SolidCraft), lire son `HOSTING.md`, sonder dans Chrome (`ready`, `accept` de sa boîte Ouvrir,
`commands()`, clés `localStorage`, CSP), puis compléter son entrée dans `apps.json` : `name`, `description`, `extensions` (édités),
`imports` (seulement ouverts), `prefKeys` (clés de réglages relevées), `control.save` (commande d'enregistrement : id, ou
`{command|request, params}` avec `{name}` = nom du document) et `control.theme` (`light`/`dark`/`system` → commande). Ajouter son
cas dans `e2e/apps.e2e.mjs` et faire passer `npm run test:e2e`.
Applications vérifiées : PdfCraft 0.21.1 et WordCraft 0.18.1 (phase 0) ; GridCraft 0.19.1, DeckCraft 0.18.1, CadCraft 0.20.1 et
FigCraft 0.18.1 (14/11/2026, `FINDINGS.md`) ; en interception DesignCraft 0.20.1, SoundCraft 0.20.1, VectorCraft 0.24.1,
TextureCraft 0.6.1, MaterialCraft 0.4.1, EffectCraft 0.24.1, Craft Anything 0.6.1, SolidCraft 0.41.0 (14/11/2026). Non vérifiées :
PhotoCraft, FilmCraft, LightCraft (à voir plus tard), MailCraft 0.11.1 (partiellement, désactivée).
Une nouvelle version d'une application vérifiée doit repasser `npm run test:e2e` avant d'être épinglée.
**Mode interception (décision du 14/11/2026)** pour les applications sans pont (`mode: "intercept"` dans `apps.json`) : pas de
`?host=parent` ; prête quand `window.wasmBindings` (ou son API) existe ; Ouvrir = sélecteur Crafty remis à son champ fichier ;
Enregistrer = téléchargement `<a download>` ou `showSaveFilePicker` capté (`public/intercept.js`) ; réouverture depuis Crafty par
fichier déposé (`control.open: "drop"`, défaut), Ctrl+O simulé sur le canvas focalisé (`"keys"` : fichier remis au champ, à
`showOpenFilePicker` ou à la fenêtre de repli de rfd), ou commande de l'API (`control.open: {command, params, fetch?}` avec `{name}`,
`{base64}`, `{path}`). `control.saveData` (`{command, params, field | read, title?}`) : Crafty tient Ctrl+S et fait sérialiser le
document par l'API (VectorCraft, EffectCraft). Les poignées et promesses rendues à l'iframe doivent être de son contexte (wasm-bindgen
vérifie `instanceof`). Pas d'état « modifié » : une frappe ou un clic depuis le dernier enregistrement compte comme modification
possible (« Pensez à enregistrer »). Pas de sauvegarde automatique ni de thème. `imports: ["*"]` = tout fichier (Craft Anything, lecture
seule). La capture des téléchargements vaut aussi en mode pont (exports PdfCraft rangés dans Crafty).
Actives : DesignCraft, SoundCraft, VectorCraft, TextureCraft, MaterialCraft, EffectCraft, Craft Anything, SolidCraft (14/11/2026),
MailCraft 0.11.1 (15/11/2026, boîte par compte ; 0.12.0 plante). Désactivées : FilmCraft et LightCraft (pont, mais limites), PhotoCraft.

Une application n'est proposée que si `enabled: true` dans `apps.json` (`fetch-app` met `false`). Voir `FINDINGS.md` pour chaque
application ; PhotoCraft s'emballe autrement et ne démarre pas tel que servi.
