import { AI_PROVIDERS } from './ai.js';
// Messages du serveur en anglais (voir src/i18n.js) : texte français exact → anglais ; PATTERNS : [expression, remplacement].
export default {
  // Commun
  'Introuvable.': 'Not found.',
  'Connexion requise.': 'Sign-in required.',
  'Trop de requêtes.': 'Too many requests.',
  'Erreur interne.': 'Internal error.',

  // Connexion, comptes (auth.js, app.js)
  'Requête refusée (origine).': 'Request refused (origin).',
  'Changez votre mot de passe.': 'Please change your password.',
  'Trop de tentatives, réessayez dans une minute.': 'Too many attempts. Try again in a minute.',
  'Compte verrouillé pendant 15 minutes après trop d\'échecs.': 'Account locked for 15 minutes after too many failed attempts.',
  'Identifiant ou mot de passe incorrect.': 'Incorrect username or password.',
  'Identifiant : 3 à 32 caractères parmi lettres, chiffres, . _ -': 'Username: 3 to 32 characters (letters, digits, . _ -)',
  'Les inscriptions sont fermées.': 'Sign-ups are closed.',
  'Trop de comptes créés depuis cette adresse.': 'Too many accounts created from this address.',
  'Le mode invité est désactivé.': 'Guest mode is disabled.',
  'Trop de sessions invitées depuis cette adresse.': 'Too many guest sessions from this address.',

  // Double authentification (twofactor.js)
  'Nom invalide.': 'Invalid name.',
  'Code incorrect.': 'Incorrect code.',
  'Délai dépassé : reconnectez-vous.': 'Time is up: please sign in again.',
  'Trop de codes faux : reconnectez-vous.': 'Too many wrong codes: please sign in again.',
  'Compte relié à Dashy : la double authentification se règle dans Dashy.': 'This account signs in with Dashy: two-factor authentication is set up in Dashy.',
  'La double authentification est déjà active.': 'Two-factor authentication is already on.',
  'La double authentification n\'est pas active.': 'Two-factor authentication is not on.',
  'Recommencez la mise en place.': 'Please start the setup again.',
  'Mot de passe actuel incorrect.': 'Current password is incorrect.',
  'Choisissez un mot de passe différent.': 'Choose a different password.',
  'Thème invalide.': 'Invalid theme.',
  'Cet identifiant existe déjà.': 'This username is already taken.',

  // Administration (admin.js)
  'Rôle invalide.': 'Invalid role.',
  'Liste d\'applications invalide.': 'Invalid app list.',
  'Quota invalide.': 'Invalid quota.',
  'Compte introuvable.': 'Account not found.',
  'Il doit rester au moins un administrateur actif.': 'At least one active administrator must remain.',
  'Vous ne pouvez pas désactiver votre propre compte.': 'You can’t disable your own account.',
  'Vous ne pouvez pas supprimer votre propre compte.': 'You can’t delete your own account.',

  // Fichiers, dossiers, corbeille, miniatures (files.js)
  'Dossier introuvable.': 'Folder not found.',
  'Fichier introuvable.': 'File not found.',
  'Trop de fichiers portant ce nom.': 'Too many files with this name.',
  'Fichier trop gros.': 'File too large.',
  'Espace de stockage plein.': 'Storage is full.',
  'Élément introuvable dans la corbeille.': 'Item not found in the trash.',
  'Liste d\'éléments invalide.': 'Invalid item list.',
  'Nom de dossier invalide.': 'Invalid folder name.',
  'Impossible de déplacer un dossier dans lui-même.': 'A folder can’t be moved into itself.',
  'Nom de fichier invalide.': 'Invalid file name.',
  'Version introuvable.': 'Version not found.',
  'Application invalide.': 'Invalid app.',
  'Pas de miniature.': 'No thumbnail.',
  'La miniature ne correspond plus à la version courante.': 'The thumbnail no longer matches the current version.',
  'Image WebP, PNG ou JPEG attendue.': 'A WebP, PNG or JPEG image is expected.',
  'Miniature trop grosse (300 Kio au plus).': 'Thumbnail too large (300 KiB max).',
  'Élément invalide.': 'Invalid item.',
  'Un élément porte déjà ce nom ici.': 'An item with this name already exists here.',
  'Contenu introuvable.': 'Content not found.',

  // Données des applications (appdata.js)
  'Envoi interrompu.': 'Upload interrupted.',
  'Données vides.': 'No data received.',
  'Données trop volumineuses.': 'Data too large.',

  // Réglages des applications (prefs.js)
  'Format invalide.': 'Invalid format.',
  'Réglages trop volumineux.': 'Settings too large.',

  // Partage par lien (shares.js)
  'Le partage est désactivé par l\'administrateur.': 'Sharing has been disabled by the administrator.',
  'Durée invalide.': 'Invalid duration.',
  'Lien introuvable.': 'Link not found.',
  'Ce lien n\'existe pas ou a expiré.': 'This link doesn’t exist or has expired.',

  // Assistant IA (ai.js)
  'Liste de comptes invalide.': 'Invalid account list.',
  'Limite par heure invalide.': 'Invalid hourly limit.',
  'Nombre d\'étapes invalide.': 'Invalid number of steps.',
  'Fournisseur inconnu.': 'Unknown provider.',
  'Adresse invalide (http ou https).': 'Invalid URL (http or https).',
  'Effort invalide.': 'Invalid effort level.',
  'Fournisseur incomplet : activé, adresse, modèle et clé.': 'Incomplete provider: it must be enabled and have a URL, a model and a key.',
  'Aucun fournisseur d\'IA n\'est configuré.': 'No AI provider is configured.',
  'Conversation invalide.': 'Invalid conversation.',
};

// Du plus précis au plus général : le premier motif qui correspond l'emporte. Le libellé du fournisseur « Compatible
// OpenAI (…) » est traduit lui aussi ; les autres sont des noms propres. Le dernier motif (« fournisseur : message
// d'erreur renvoyé par l'API », texte non traduisible) ne fait que remettre la ponctuation à l'anglaise.
const CUSTOM = 'Compatible OpenAI \\(LM Studio, vLLM…\\)';
const CUSTOM_EN = 'OpenAI-compatible (LM Studio, vLLM…)';
export const PATTERNS = [
  [/^Mot de passe : au moins (.+) caractères\.$/, 'Password: at least $1 characters.'],
  [/^Valeur invalide pour (.+)\.$/, 'Invalid value for $1.'],
  [/^Le contenu ne correspond pas à un fichier \.(.+)\.$/, 'The content doesn’t match a .$1 file.'],
  [/^Clé inconnue : (.+)$/s, 'Unknown key: $1'],
  [/^Réglage trop gros : (.+)$/s, 'Setting too large: $1'],
  [/^Fournisseur inconnu : (.+)$/s, 'Unknown provider: $1'],
  [/^Limite atteinte : (.+) échanges par heure\.$/, 'Limit reached: $1 requests per hour.'],
  [new RegExp(`^${CUSTOM} : pas de réponse \\(délai dépassé\\)\\.$`), `${CUSTOM_EN}: no response (timed out).`],
  [new RegExp(`^${CUSTOM} : réponse sans message\\.$`), `${CUSTOM_EN}: the response contained no message.`],
  [new RegExp(`^${CUSTOM} : (.+)$`, 's'), `${CUSTOM_EN}: $1`],
  [/^(.+?) : pas de réponse \(délai dépassé\)\.$/, '$1: no response (timed out).'],
  [/^(.+?) : réponse sans message\.$/, '$1: the response contained no message.'],
  // Erreur brute d'un fournisseur d'IA : seulement derrière le nom d'un fournisseur connu (sinon une phrase française non
  // traduite contenant « : » passerait le test de couverture).
  [new RegExp(`^(${AI_PROVIDERS.map((p) => p.label.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`)).join('|')}) : (.+)$`, 's'), '$1: $2'],
];
