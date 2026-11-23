# Crafty (craft-host)

Héberge les applications web Craft (PdfCraft, WordCraft…) derrière une connexion, avec un espace de fichiers
par compte (dossiers, versions, quotas). Les applications tournent dans le navigateur ; le serveur authentifie,
stocke les fichiers et sert les zips officiels sans les modifier. Décisions et règles : `CLAUDE.md`.

## Démarrer en local

Node 22 ou plus. Pas besoin de Docker.

```bash
npm install
npm run fetch pdfcraft
npm run fetch wordcraft
npm start
```

Les autres applications : `npm run fetch <slug>` (dépôts `storytold/<slug>`) ou `npm run fetch <propriétaire>/<slug>`
(`tangency-labs/solidcraft`, `UCS-Care-Group/mailcraft`), puis `enabled: true` dans `apps.json` une fois vérifiée.

Ouvrir http://localhost:8787/ : le premier compte créé devient administrateur. Le serveur n'écoute que sur
`127.0.0.1` et `[::1]`.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `8787` | Port d'écoute |
| `HOST` | `127.0.0.1` | Adresse d'écoute (`0.0.0.0` dans un conteneur) |
| `DATA_DIR` | `./data` | Base SQLite, fichiers (`blobs/`), journaux (`logs/auth.log`) |
| `TRUST_PROXY` | désactivé | Nombre de mandataires de confiance (Cloudflare + Traefik : à régler et vérifier) |
| `COOKIE_SECURE` | `0` | `1` derrière HTTPS terminé par le mandataire |
| `SCRYPT_N` | `32768` | Coût du hachage des mots de passe (viser environ 100 ms sur le VPS) |
| `CRAFTY_SECRET` | aucun | Chiffre les clés des fournisseurs d'IA et les secrets de double authentification (AES-256-GCM). Sans lui, ils sont gardés en clair dans la base. |
| `APPS_FILE` | `./apps.json` | Registre des applications (essais : un registre qui en active d'autres) |
| `CSP` | `auto` | `auto` (stricte, empreintes calculées), `off`, ou une politique fixe |
| `PRECOMPRESSED_DIR` | `./precompressed` | Sortie de `scripts/precompress.mjs` (Brotli 11 + gzip), servie depuis le disque |
| `STATIC_CACHE_MB` | `256` | Mémoire du cache de compression à la volée |
| `BACKUP_EVERY_HOURS` | `0` | Instantané de la base dans `DATA_DIR/backups` (24 dans l'image Docker) ; `BACKUP_KEEP` : 14 |
| `PUBLIC_ORIGIN`, `SSO_SHARED_SECRET`, `SSO_DASHY_URL` | aucun | Connexion unique avec Dashy (les trois sont nécessaires) ; `PUBLIC_ORIGIN` fixe aussi les adresses données à Kosmy Board |

## Se connecter avec Kosmy Board

Crafty accepte la connexion par [Kosmy Board](https://github.com/PetitOursManu/Kosmy-Board) (OpenID Connect), selon la convention
des applis Kosmy :

| Rôle | Adresse |
|---|---|
| Lancement | `{adresse de Crafty}/auth/kosmy-board/login` |
| Retour | `{adresse de Crafty}/auth/kosmy-board/callback` |

1. Dans le Board, ajoutez l'instance Crafty, puis **Modifier → Connexion unique** et activez-la (`client_secret_basic`).
2. Dans Crafty, **Administration → Système → Connexion avec Kosmy Board** : collez l'émetteur, l'identifiant client et le secret
   (en écriture seule, chiffré par `CRAFTY_SECRET`). La carte affiche aussi les deux adresses à donner au Board ; derrière un proxy,
   réglez `PUBLIC_ORIGIN` pour qu'elles soient exactes.
3. Chaque personne relie son compte une fois : connectée avec son mot de passe, menu du compte → **Relier à Kosmy Board**.
   Ensuite, « Se connecter avec Kosmy Board » sur la page de connexion, ou « Ouvrir » dans le Board, ouvre ce compte.

Les comptes se relient par l'identifiant du Board (`sub`), jamais par l'e-mail, que le Board ne vérifie pas. Défaire le lien demande
le mot de passe Crafty (l'admin peut aussi le faire depuis la liste des comptes). La création automatique d'un compte à la première
connexion est désactivée par défaut ; un compte créé ainsi est toujours un simple utilisateur, sans mot de passe. Se déconnecter de
Crafty ne ferme pas la session du Board.

## Admin dans Kosmy Board

Le bouton « Admin » du Board affiche l'administration de Crafty dans le Board lui-même, sans ouvrir Crafty
([protocole `kosmy.board-admin.v1`](https://github.com/PetitOursManu/Kosmy-Board/blob/main/docs/admin-api.md)). Le serveur du Board
appelle `/api/kosmy-board/admin` (sommaire) et `/api/kosmy-board/admin/{section}` (GET : contenu, POST : action) avec un jeton d'une
seule requête signé par sa clé OpenID Connect.

- **Prérequis** : la connexion avec Kosmy Board réglée (section précédente), et le compte Board de la personne **relié** à un compte
  Crafty **administrateur**, actif et sans mot de passe provisoire en attente. Le Board ne donne aucun droit : sinon, refus
  (`not_linked` ou `forbidden`, avec un message). Le serveur du Board doit joindre Crafty à l'adresse saisie dans le Board.
- **Ce qui s'y trouve** : vue d'ensemble (comptes, sessions, fichiers, espace, liens de partage, version, applications) ; comptes
  (création avec mot de passe provisoire montré une fois, rôle, applications, quota, nouveau mot de passe provisoire, déverrouillage,
  retrait de la double authentification, déliaison Dashy / Kosmy Board, désactivation, suppression) ; réglages (accès, applications
  des invités, fichiers) ; assistant IA (accès, limites, fournisseurs, clés en écriture seule, essai, consommation) ; système
  (connexion avec Kosmy Board, création automatique de compte, Dashy, chiffrement des secrets, sauvegardes) ; journal.
- **Mêmes règles que l'administration de Crafty** : chaque action passe par les mêmes fonctions (contrôles, effets, journal d'audit,
  noté `via: kosmy-board`). Aucun secret existant n'est renvoyé. Depuis le Board, on ne change ni le rôle, ni l'état, ni le mot de
  passe, ni le lien Kosmy Board de son propre compte, ni l'émetteur, l'identifiant ou le secret client (cela couperait l'accès du Board).
- **Restent dans Crafty** : la vérification de l'adresse IP réelle (`TRUST_PROXY`, à faire depuis un navigateur) et le réglage de la
  connexion avec Kosmy Board elle-même (émetteur, identifiant, secret, désactivation).
- Textes en français ou en anglais selon la langue de la personne dans le Board (`Accept-Language`).

## Utilisateurs gérés par Kosmy Board

Un administrateur du Board peut donner (ou retirer) l'accès à Crafty à une personne, avec son rôle et ses restrictions : le Board
crée, met à jour ou désactive alors son compte Crafty ([protocole `kosmy.board-users.v1`](https://github.com/PetitOursManu/Kosmy-Board/blob/main/docs/users-api.md)).
Le serveur du Board appelle `GET /api/kosmy-board/users`, `PUT` et `DELETE /api/kosmy-board/users/{sub}` avec le même jeton et les
mêmes prérequis que l'admin dans le Board (le compte Board de celui qui agit relié à un compte Crafty administrateur actif).

- **Rôles** : Administrateur (droits d'administration de Crafty) et Utilisateur.
- **Restrictions**, appliquées par Crafty : quota d'espace (en Gio, vide = quota par défaut ; tous les rôles), applications
  autorisées (toutes, ou une case par application) et accès à l'assistant IA (sans effet si l'assistant est désactivé ou ouvert à
  tous les comptes) ; ces deux dernières pour les utilisateurs seulement (un administrateur a tout).
- **Création** : compte sans mot de passe (connexion par le Board seulement), identifiant tiré du nom, fixé ensuite. Un compte
  existant non relié est **repris** s'il porte l'adresse e-mail donnée par le Board : l'adresse d'un compte se saisit dans
  Administration → Comptes → Modifier. Adresse déjà reliée à une autre personne du Board, ou portée par plusieurs comptes : refus (409).
- **Retrait de l'accès** : le compte est **désactivé** (ses fichiers restent) : connexion par mot de passe, par le Board ou par Dashy
  refusée, sessions fermées, liens de partage coupés, admin dans le Board refusé. Un nouvel accès donné dans le Board le réactive.
- **À la connexion par le Board**, l'accès transmis dans l'ID token (`kosmy_board_access`) est appliqué de la même façon, et le compte
  créé s'il n'existe pas encore (même sans la création automatique) ; jamais de reprise par l'e-mail à ce moment-là, et un compte
  désactivé ne se connecte pas.
- Garde-fous : on ne se retire ni ses propres droits d'administration ni son propre accès, et il reste toujours un administrateur actif.

## Installer sur Coolify

L'image est prête et essayée en local (santé, arrêt propre, redémarrage sans perte, sauvegarde et restauration). Les
réglages Coolify ci-dessous viennent de sa documentation : ils n'ont pas encore été essayés sur un vrai serveur.
Détail de chaque point : `docs/DEPLOIEMENT.md`.

1. **Créer la ressource** : *New Resource* → dépôt GitHub `PetitOursManu/Crafty`, branche `main`, *Build Pack*
   **Dockerfile**.
2. **Réseau** : port exposé `8787`. Domaine, par exemple `https://crafty.example.com` (Traefik fait le TLS).
   Ne publiez pas le port sur l'hôte : c'est Traefik qui expose le service.
3. **Stockage** : *Persistent Storage* → un volume monté sur **`/data`**. Tout l'état y vit : base, fichiers, journaux et
   instantanés. Sans ce volume, un redéploiement efface tout.
4. **Variables d'environnement** (modèle : `.env.example`) :

   | Variable | Valeur |
   |---|---|
   | `CRAFTY_SECRET` | `openssl rand -base64 48`, à générer une fois et à **garder avec les sauvegardes** |
   | `COOKIE_SECURE` | `1` |
   | `TRUST_PROXY` | `2` derrière Cloudflare + Traefik, `1` avec Traefik seul (à vérifier à l'étape 7) |
   | `PUBLIC_ORIGIN` | `https://crafty.example.com`, nécessaire à Dashy et à Kosmy Board |
   | `SCRYPT_N` | `32768` pour commencer, à mesurer à l'étape 8 |

5. **Limites** : CPU 2, mémoire 1 Gio, c'est suffisant. La sonde de santé (`/api/health`) vient du `Dockerfile`.
6. **Déployer.** Le premier build télécharge les 18 applications, vérifie leur SHA-256 et les précompresse en Brotli 11.
   Il a pris 13 min sur 12 cœurs ; sur un VPS de 2 à 4 cœurs, comptez 30 à 60 min (estimation). Les builds suivants
   réutilisent le cache : 37 s quand seul le code change, environ 7 min avec trois nouvelles applications. L'image fait
   2,7 Go.
7. **Créer tout de suite le compte administrateur.** Le premier compte inscrit devient administrateur, puis l'inscription
   publique se ferme. Ensuite, *Administration → Système → Adresse IP réelle*, ouvert depuis l'extérieur par le
   domaine : réglez `TRUST_PROXY` jusqu'au verdict « Correct ». Derrière Cloudflare, Traefik doit faire confiance à
   ses plages d'adresses (`forwardedHeaders.trustedIPs`, voir § 3 de `docs/DEPLOIEMENT.md`).
8. **Mesurer le hachage des mots de passe**, puis ajuster `SCRYPT_N` pour viser environ 100 ms :

   ```bash
   docker exec <conteneur> node scripts/scrypt-bench.mjs
   ```

9. **Finir** : double authentification sur le compte administrateur, fail2ban (`deploy/fail2ban/`), copie des
   instantanés de `/data/backups` hors du VPS avec un essai de restauration, puis Dashy ou Kosmy Board si souhaité.

## Déploiement et exploitation

Coolify, Docker, adresse IP réelle, sauvegarde et restauration, mise à jour d'une application, fail2ban, comptes de secours,
double authentification, SSO : `docs/DEPLOIEMENT.md`. Essai local de l'image (liée à 127.0.0.1) :

```bash
docker compose up -d --build
```

Scripts : `node scripts/update-app.mjs [slug]`, `node scripts/accounts.mjs list`, `node scripts/backup.mjs [list | restore <nom>]`,
`node scripts/scrypt-bench.mjs`, `node scripts/precompress.mjs`.

## Tests

```bash
npm test
```

```bash
npm run test:e2e
```

`test:e2e` lance Chrome (installé, ou `PW_CHROMIUM`) sur les vraies applications ; `HEADED=1` pour voir la fenêtre.
