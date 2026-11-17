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
| `PUBLIC_ORIGIN`, `SSO_SHARED_SECRET`, `SSO_DASHY_URL` | aucun | Connexion unique avec Dashy (les trois sont nécessaires) |

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
