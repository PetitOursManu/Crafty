// craft-host : point d'entrée. Toute la logique est dans src/.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, tuneServer } from './src/app.js';

export { createApp };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // HOST : 127.0.0.1 par défaut (rien n'est exposé hors de la machine) ; dans le conteneur, HOST=0.0.0.0.
  const port = Number(process.env.PORT || 8787), host = process.env.HOST || '127.0.0.1', app = createApp();
  tuneServer(app.listen(port, host, () => console.log(`craft-host : http://localhost:${port}/`)));
  if (host === '127.0.0.1') tuneServer(app.listen(port, '::1')).on('error', (e) => console.warn(`[::1]:${port} indisponible : ${e.code}`));
}
