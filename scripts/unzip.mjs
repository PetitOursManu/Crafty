// Lecteur zip minimal (stored + deflate), sans dépendance. Refuse les chemins dangereux
// et vérifie le CRC-32 de chaque entrée. Suffisant pour les zips web des releases Craft.
import { inflateRawSync, crc32 } from 'node:zlib';

const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;

export function listZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip : fin de répertoire central introuvable');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64 non pris en charge');
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CEN) throw new Error('zip : répertoire central corrompu');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (flags & 1) throw new Error(`zip : entrée chiffrée ${name}`);
    entries.push({ name, method, crc, csize, usize, local });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

export function safeName(name) {
  if (name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  return !name.split('/').some((s) => s === '..' || s === '.');
}

export function readEntry(buf, e) {
  if (buf.readUInt32LE(e.local) !== LOC) throw new Error(`zip : en-tête local invalide (${e.name})`);
  const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
  const raw = buf.subarray(start, start + e.csize);
  let data;
  if (e.method === 0) data = raw;
  else if (e.method === 8) data = inflateRawSync(raw);
  else throw new Error(`zip : méthode ${e.method} non prise en charge (${e.name})`);
  if (data.length !== e.usize) throw new Error(`zip : taille inattendue (${e.name})`);
  if ((crc32(data) >>> 0) !== e.crc) throw new Error(`zip : CRC-32 faux (${e.name})`);
  return data;
}
