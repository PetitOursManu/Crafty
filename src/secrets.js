// Chiffrement des secrets gardés en base (clés des fournisseurs d'IA, secrets de double authentification) :
// AES-256-GCM avec une clé dérivée de CRAFTY_SECRET et d'un sel propre à chaque usage. Sans CRAFTY_SECRET, le secret
// est gardé en clair (préfixe plain:), ce que l'administration signale. Un CRAFTY_SECRET changé rend les secrets
// chiffrés illisibles : open() renvoie alors ''.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export function makeSealer(secret, salt) {
  const key = secret ? scryptSync(secret, salt, 32) : null;
  const seal = (plain) => {
    if (!plain) return '';
    if (!key) return `plain:${plain}`;
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
  };
  const open = (stored) => {
    if (!stored) return '';
    if (stored.startsWith('plain:')) return stored.slice(6);
    if (!key) return ''; // chiffré mais secret absent : inutilisable
    try {
      const b = Buffer.from(stored.slice(3), 'base64');
      const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    } catch { return ''; } // secret changé
  };
  return { seal, open, encrypted: !!key };
}
