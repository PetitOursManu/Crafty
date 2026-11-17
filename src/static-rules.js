// Règles communes au serveur (src/static.js) et à la précompression au build (scripts/precompress.mjs).
// Fichier à part, sans dépendance : la couche Docker de précompression ne se refait que s'il change.
import { createHash } from 'node:crypto';

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.onnx': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json',
};
// .onnx (modèles OCR) : gain de compression nul (mesuré), donc servis tels quels.
export const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.wasm', '.json', '.css', '.svg', '.txt', '.md', '.toml', '.webmanifest']);
// ETag : début de l'empreinte SHA-256 du contenu d'origine (le même au build et à la volée).
export const etagOf = (data) => createHash('sha256').update(data).digest('base64url').slice(0, 27);
