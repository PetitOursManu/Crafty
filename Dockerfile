# syntax=docker/dockerfile:1
# Image de Crafty (craft-host) pour Coolify : voir docs/DEPLOIEMENT.md.
# Les applications ne sont pas dans le dépôt : elles sont téléchargées au build depuis leurs releases GitHub, à la
# version et au SHA-256 épinglés dans apps.json (scripts/vendor-install.mjs), puis précompressées en Brotli 11 + gzip
# (scripts/precompress.mjs). Cette étape ne dépend que d'apps.json et de ses scripts : modifier le code ne la refait pas.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---- Dépendances de production (better-sqlite3 : binaire précompilé, sinon compilation) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 || (apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
     && npm ci --omit=dev --no-audit --no-fund --build-from-source) \
 && npm cache clean --force

# ---- Applications Craft : téléchargées, vérifiées, précompressées ----
FROM ${NODE_IMAGE} AS vendor
WORKDIR /app
# Brotli 11 : environ 2 min de CPU par wasm de 60 Mo ; PRECOMPRESS_QUALITY=5 pour un essai rapide.
ARG PRECOMPRESS_QUALITY=11
COPY apps.json ./
COPY src/static-rules.js src/
COPY scripts/unzip.mjs scripts/vendor-lib.mjs scripts/vendor-install.mjs scripts/verify-vendor.mjs scripts/precompress.mjs scripts/
# Caches de build (BuildKit) : un apps.json modifié ne retélécharge et ne recompresse que ce qui a changé.
RUN --mount=type=cache,target=/cache \
    mkdir -p /cache/vendor /cache/precompressed \
 && VENDOR_DIR=/cache/vendor node scripts/vendor-install.mjs \
 && mkdir -p vendor && for d in /cache/vendor/*/; do \
      slug=$(basename "$d"); \
      v=$(node -e "const a=require('./apps.json')['$slug'];process.stdout.write(a&&a.enabled!==false?a.version:'')"); \
      if [ -n "$v" ] && [ -d "$d$v" ]; then mkdir -p "vendor/$slug" && cp -a "$d$v" "vendor/$slug/" && cp "$d$v.sha256" "vendor/$slug/"; fi; \
    done \
 && node scripts/verify-vendor.mjs \
 && PRECOMPRESSED_DIR=/cache/precompressed PRECOMPRESS_QUALITY=${PRECOMPRESS_QUALITY} node scripts/precompress.mjs \
 && mkdir -p precompressed && cp /cache/precompressed/manifest.json precompressed/ \
 && node -e "const m=require('./precompressed/manifest.json');for(const[k,v]of Object.entries(m)){for(const e of['br','gz'])if(v[e])console.log(k+'.'+e)}" \
    | while read -r f; do mkdir -p "precompressed/$(dirname "$f")" && cp "/cache/precompressed/$f" "precompressed/$f"; done

# ---- Image finale ----
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    STATIC_CACHE_MB=64 \
    BACKUP_EVERY_HOURS=24 \
    BACKUP_KEEP=14
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=vendor /app/vendor vendor
COPY --from=vendor /app/precompressed precompressed
COPY package.json apps.json server.js ./
COPY src src
COPY public public
COPY scripts scripts
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
