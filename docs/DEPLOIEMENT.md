# Déploiement et exploitation de Crafty (Coolify)

État au 17/11/2026 : tout est prêt dans le dépôt, rien n'est déployé. Chaque point dit ce qui a été **vérifié**
(exécuté ici, Docker Desktop, image `crafty:test`) et ce qui est **lu dans la doc** (à confirmer sur le VPS).

## 1. L'image

`Dockerfile`, trois étapes :

1. **deps** : `npm ci --omit=dev` (better-sqlite3 précompilé ; compilation en repli). Vérifié : la base s'ouvre dans l'image.
2. **vendor** : `scripts/vendor-install.mjs` télécharge chaque application **activée** d'`apps.json` depuis sa release GitHub
   et refuse tout zip dont le SHA-256 n'est pas celui épinglé ; `verify-vendor.mjs` contrôle chaque fichier ;
   `precompress.mjs` produit `precompressed/` en Brotli 11 et gzip. Cette étape ne dépend que d'`apps.json` et de ses
   scripts : modifier le code ne la refait pas. Caches BuildKit : un `apps.json` modifié ne retélécharge et ne
   recompresse que ce qui a changé.
3. **finale** : Node 24, utilisateur `node` (pas root), `HOST=0.0.0.0`, `DATA_DIR=/data` (volume), sonde de santé
   `/api/health` (base lisible, `/data` accessible en écriture, au moins une application).

Mesures (vérifié, 12 cœurs) :

| | |
|---|---|
| Premier build complet | 13 min, dont 11 min de Brotli 11 (181 fichiers, 747 Mo → 164 Mo) |
| Rebuild après une modification du code | 37 s |
| Taille de l'image | 2,3 Go (applications 735 Mo, précompressées 410 Mo) |
| wasm de PdfCraft servi | 13,6 Mo en Brotli (60,6 Mo décompressé), depuis le disque |
| Arrêt (`docker stop`) | 2,2 s, code 0 (SIGTERM : requêtes finies, base fermée) |

Sur un VPS de 2 à 4 cœurs, compter 30 à 60 min pour le premier build (estimation : la compression se répartit sur les
cœurs). Pour un essai : argument de build `PRECOMPRESS_QUALITY=5`.

Essai local (vérifié) :

```bash
docker compose up -d --build
```

→ http://127.0.0.1:8787 (lié à la boucle locale ; `CRAFTY_BIND` pour changer).

## 2. Ressource Coolify

Lu dans la doc de Coolify, à confirmer à l'installation :

- **Nouvelle ressource** → dépôt GitHub `PetitOursManu/Crafty`, branche `main`, *Build Pack* **Dockerfile**.
- **Port exposé** : `8787`. **Domaine** : `https://crafty.emanuelvigreux.fr` (ou autre), Traefik fait le TLS.
- **Persistent Storage** : un volume monté sur `/data`. Tout l'état y est : base, fichiers, journaux, instantanés.
- **Variables d'environnement** : voir `.env.example`. Au minimum `CRAFTY_SECRET`, `COOKIE_SECURE=1`,
  `TRUST_PROXY` (§ 3), `PUBLIC_ORIGIN` si SSO.
- **Limites** : CPU 2, mémoire 1 Gio. Le cache de compression à la volée est borné (`STATIC_CACHE_MB=64`).
  Chaque connexion en cours prend 32 Mio pendant le hachage (`SCRYPT_N=32768`).
- **Healthcheck** : celui du Dockerfile (`/api/health`).

## 3. Adresse IP réelle (`TRUST_PROXY`)

Limites par IP, verrouillage, journal d'audit et fail2ban reposent sur l'adresse du visiteur. Si elle est fausse, tout
le monde partage la même limite, et fail2ban bannirait le proxy.

Chaîne prévue : visiteur → Cloudflare → Traefik → Crafty. Lu dans la doc, non vérifié :

- Par défaut, Traefik **remplace** `X-Forwarded-For` par l'adresse de Cloudflare : l'adresse du visiteur est perdue.
  Il faut que Traefik fasse confiance à Cloudflare : dans Coolify (*Servers → Proxy*), sur les points d'entrée `web` et
  `websecure`, `forwardedHeaders.trustedIPs` = plages publiées par Cloudflare (https://www.cloudflare.com/ips/).
- Alors `X-Forwarded-For` = `visiteur, Cloudflare`, et la connexion arrive de Traefik : **`TRUST_PROXY=2`**.
- Sans Cloudflare (DNS seul) : `TRUST_PROXY=1`.

**Vérification** (outil prêt, vérifié en local) : *Administration → Système → Adresse IP réelle*, depuis l'extérieur par
le domaine public. Verdict « Correct » quand l'adresse retenue est celle de `CF-Connecting-IP` (l'adresse que
Cloudflare a reçue). Comparer aussi avec son adresse publique.

## 4. Secrets

- `CRAFTY_SECRET` (`openssl rand -base64 48`) chiffre les clés d'IA et les secrets de double authentification. À garder
  avec les sauvegardes : sans lui, la double authentification de chaque compte est à refaire (§ 9).
- `SCRYPT_N` : mesurer sur le VPS avec la commande ci-dessous et viser environ 100 ms. Mesuré ici : 32768 → 130 ms.

```bash
docker exec crafty node scripts/scrypt-bench.mjs
```

## 5. Sauvegarde et restauration

Vérifié dans le conteneur :

- Instantané cohérent de la base toutes les `BACKUP_EVERY_HOURS` heures (24 dans l'image) dans `/data/backups/`, 14
  gardés. Il est pris à chaud par l'API de sauvegarde de SQLite.
- Les contenus (`blobs/`, `appdata/`, `thumbs/`) ne sont jamais réécrits une fois créés (nom UUID, écriture atomique). Une
  copie du volume par l'hôte suffit pour eux, avec `backups/`.
- Une copie hors du VPS reste à mettre en place côté hôte (restic, rsync, sauvegardes du fournisseur), sur le dossier du
  volume :

```bash
docker volume inspect <volume> --format '{{ .Mountpoint }}'
```

Commandes :

```bash
docker exec crafty node scripts/backup.mjs
```

```bash
docker exec crafty node scripts/backup.mjs list
```

Restauration (vérifiée : refusée tant que le serveur répond ; ensuite base remise, ancienne gardée à côté, redémarrage sain,
données de l'instantané retrouvées) :

1. Arrêter la ressource dans Coolify.
2. Lancer la restauration dans un conteneur jetable branché sur le même volume :

   ```bash
   docker run --rm -v <volume>:/data <image> node scripts/backup.mjs restore craft-AAAAMMJJ-HHMMSS.db
   ```

3. Redémarrer la ressource.

Les fichiers envoyés après l'instantané restent sur le disque mais n'apparaissent plus (leur trace en base est antérieure).

## 6. Mise à jour d'une application (phase 5)

Comparer les versions épinglées aux dernières releases (vérifié : signale MailCraft 0.13.0 et SolidCraft 0.44.0 le 17/11/2026) :

```bash
node scripts/update-app.mjs
```

Mettre à jour une application, sur le poste de développement (Chrome nécessaire pour les tests) :

```bash
node scripts/update-app.mjs solidcraft
```

Ce que fait le script :

1. Il télécharge la release et vérifie son SHA-256.
2. Il épingle la nouvelle version dans `apps.json`.
3. Il passe les tests e2e de l'application.
4. Si un test échoue, ou s'il n'y a aucun test pour elle, `apps.json` revient à l'ancienne version.

Vérifié : SolidCraft 0.41.0 → 0.44.1 le 17/11/2026 (test réussi, version épinglée), et en échec sur un tag
inexistant (`apps.json` intact).

Ensuite : committer `apps.json`, puis redéployer. Sessions et fichiers sont dans `/data`, donc personne n'est déconnecté.
Revenir en arrière, c'est remettre l'ancienne version dans `apps.json`.

## 7. fail2ban

Fichiers : `deploy/fail2ban/crafty.conf` (filtre) et `deploy/fail2ban/jail.local.example` (prison). Le journal est
`/data/logs/auth.log` dans le volume (rotation à 5 Mo, 3 anciens fichiers). Il est aussi sur la sortie du conteneur.

- Événements bannis : `AUTH_FAIL` (mot de passe, code de double authentification, SSO refusé), `AUTH_LOCKED`,
  `AUTH_RATELIMIT`.
- Le filtre a été vérifié avec une approximation en Node (IPv4, IPv6, avec et sans date, préfixe journald). Il n'a **pas**
  été vérifié avec le vrai `fail2ban-regex`. Sur le VPS :

```bash
fail2ban-regex <volume>/_data/logs/auth.log /etc/fail2ban/filter.d/crafty.conf
```

- **Derrière Cloudflare**, un blocage iptables est sans effet : les connexions viennent de Cloudflare. Il faut l'action
  `cloudflare-token`, qui bannit chez Cloudflare (lu dans la doc de fail2ban).
- Ne l'activer qu'une fois `TRUST_PROXY` vérifié (§ 3).

## 8. Comptes de secours

Vérifié sur une base de test, utile quand plus aucun administrateur ne peut se connecter :

```bash
docker exec -it crafty node scripts/accounts.mjs list
```

Autres commandes :

- `create <nom> [--admin]` ;
- `reset-password <nom>` : mot de passe provisoire affiché une fois, sessions fermées ;
- `unlock <nom>` ;
- `disable <nom>` et `enable <nom>` ;
- `role <nom> admin|user` : refusé s'il retire le dernier administrateur actif ;
- `reset-2fa <nom>`.

Chaque action est inscrite au journal d'audit.

## 9. Double authentification (phase 6)

Côté utilisateur, menu du compte → *Double authentification…* :

- Le mot de passe est redemandé, puis un QR code s'affiche (TOTP SHA-1, 6 chiffres, 30 s) pour Aegis, Google
  Authenticator, 1Password ou Bitwarden.
- La mise en service se valide avec un premier code juste.
- 10 codes de secours sont donnés, utilisables une fois chacun et stockés hachés.

À la connexion, un mot de passe juste donne un ticket (5 min, 5 essais), puis le code ouvre la session. Protections :

- un code déjà utilisé est refusé ;
- un code faux compte comme un échec de connexion (verrouillage à 10, journal fail2ban) ;
- un bon mot de passe ne remet pas le compteur à zéro avant le code.

En cas de perte, l'administrateur retire la double authentification (*Comptes → … → Retirer la double authentification*),
ou on passe par `accounts.mjs reset-2fa`.

## 10. Connexion unique avec Dashy (phase 6)

C'est le même protocole que Mocky : Dashy signe un jeton HS256 de 60 s (`iss` = `dashy`, `aud` = adresse de Crafty, `jti` à
usage unique).

Côté Crafty :

- `SSO_SHARED_SECRET`, le même que celui de Dashy ;
- `SSO_DASHY_URL` (`https://dashy…`) ;
- `PUBLIC_ORIGIN` (`https://crafty…`).

Si l'un des trois manque, le SSO reste coupé.

Côté Dashy : ajouter `https://crafty…/sso/dashy/callback` à `SSO_ALLOWED_REDIRECTS`. L'adresse exacte est affichée dans
*Administration → Système*.

Fonctionnement :

- La connexion se lance par « Se connecter avec Dashy » sur la page de connexion.
- Une identité inconnue obtient un compte, sauf si l'administrateur coupe *Comptes créés par Dashy*. Ce compte n'a pas de
  mot de passe ; il est administrateur s'il l'est dans Dashy.
- Un compte existant se lie depuis le menu du compte → *Lier mon compte Dashy*.

Ajouts par rapport à Mocky : le `state` est vérifié par le serveur, avec un cookie `__Host-` que les autres sous-domaines
ne peuvent pas poser (pas de connexion forcée au compte d'un autre). Le rôle n'est fixé qu'à la création.

Vérifié par les tests (`test/sso.test.js`) avec des jetons signés comme le ferait Dashy. **Non vérifié avec une vraie
instance de Dashy.**

## 11. Liste de mise en service

1. Ressource Coolify, volume `/data`, domaine, variables (§ 2, § 4).
2. Premier déploiement : vérifier que la sonde de santé passe au vert.
3. Créer le compte administrateur (le premier inscrit). L'inscription publique se ferme toute seule.
4. *Administration → Système* depuis l'extérieur : régler `TRUST_PROXY` jusqu'au verdict « Correct » (§ 3).
5. `scripts/scrypt-bench.mjs` sur le VPS, puis ajuster `SCRYPT_N`.
6. Activer la double authentification sur le compte administrateur.
7. fail2ban (§ 7), puis sauvegarde hors du VPS (§ 5) avec un essai de restauration.
8. SSO Dashy si souhaité (§ 10).
