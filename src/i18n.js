// Messages du serveur en anglais pour un navigateur qui ne préfère pas le français (Accept-Language). Les messages restent
// écrits en français dans le code ; la traduction se fait à la sortie (champ « error » des réponses JSON) : dictionnaire
// exact, puis motifs pour les messages qui contiennent une valeur (src/i18n-en.js). Sans en-tête : français.
import EN, { PATTERNS } from './i18n-en.js';

export function langOf(req) {
  const h = String(req.headers['accept-language'] || '').trim();
  if (!h) return 'fr';
  const prefs = h.split(',').map((p) => { const [tag, ...params] = p.trim().split(';'); const q = params.find((x) => x.trim().startsWith('q='));
    return { tag: tag.trim().toLowerCase(), q: q ? Number(q.trim().slice(2)) || 0 : 1 }; }).filter((p) => p.tag && p.tag !== '*').sort((a, b) => b.q - a.q);
  // « * » seul (envoyé par défaut par fetch de Node, curl…) = aucune préférence : français.
  return !prefs.length || prefs[0].tag.startsWith('fr') ? 'fr' : 'en';
}
export function translate(lang, msg) {
  if (lang === 'fr' || typeof msg !== 'string') return msg;
  if (EN[msg]) return EN[msg];
  for (const [re, en] of PATTERNS) if (re.test(msg)) return msg.replace(re, en);
  return msg;
}
export function i18nMiddleware(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => json(body && typeof body.error === 'string' ? { ...body, error: translate(langOf(req), body.error) } : body);
  next();
}
