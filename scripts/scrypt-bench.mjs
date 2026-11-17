#!/usr/bin/env node
// Usage : node scripts/scrypt-bench.mjs [cible_ms=100]   (dans le conteneur : docker exec crafty node scripts/scrypt-bench.mjs)
// Mesure le coût de scrypt (r=8, p=1) sur cette machine pour régler SCRYPT_N (correction 1 de CLAUDE.md : environ
// 100 ms par connexion). Mémoire par hachage = 128 × N × r octets : avec plusieurs connexions simultanées, elle compte
// dans la limite du conteneur. Les mots de passe existants gardent leur N (il est stocké dans le hachage).
import { hashPassword, verifyPassword } from '../src/auth.js';

const target = Number(process.argv[2] || 100);
const rows = [];
for (let log = 14; log <= 17; log++) {
  const N = 2 ** log;
  const stored = await hashPassword('mesure', N);
  const times = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); await verifyPassword('mesure', stored); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  rows.push({ N, ms: times[2], mib: (128 * N * 8) / 1024 ** 2 });
  console.log(`N = 2^${log} = ${String(N).padStart(6)} : ${times[2].toFixed(0).padStart(4)} ms (médiane de 5), ${(128 * N * 8) / 1024 ** 2} Mio par hachage`);
}
const best = rows.find((r) => r.ms >= target * 0.8) || rows.at(-1);
console.log(`\nRecommandé pour ~${target} ms : SCRYPT_N=${best.N} (${best.ms.toFixed(0)} ms, ${best.mib} Mio par connexion en cours).`);
if (best.N > 65536) console.log('Au-delà de 65536, prévoir la mémoire : 8 connexions simultanées = 8 × la mémoire indiquée.');
