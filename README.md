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
