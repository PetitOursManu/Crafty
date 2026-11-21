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

  // Connexion avec Kosmy Board (kosmy-board.js)
  'Kosmy Board ne répond pas : réessayez plus tard.': 'Kosmy Board is not responding: try again later.',
  'Ce compte n\'est pas relié à Kosmy Board.': 'This account is not linked to Kosmy Board.',
  'Ce compte n\'a pas de mot de passe : demandez à l\'administrateur.': 'This account has no password: ask your administrator.',
  'Mot de passe incorrect.': 'Incorrect password.',
  'Émetteur invalide : adresse http(s) attendue.': 'Invalid issuer: an http(s) URL is expected.',
  'Identifiant client invalide.': 'Invalid client ID.',
  'Secret client invalide.': 'Invalid client secret.',
};

// Admin dans Kosmy Board (src/kosmy-admin.js) : textes propres à cette API. Les autres viennent des dictionnaires de
// l'interface (public/i18n/en-common.js, en-account.js) et des messages ci-dessus.
export const BOARD_ADMIN = {
  // Protocole : refus
  "Ce compte Kosmy Board n'est relié à aucun compte Crafty. Connectez-vous à Crafty avec votre mot de passe, puis menu du compte → Relier à Kosmy Board.":
    'This Kosmy Board account is not linked to any Crafty account. Sign in to Crafty with your password, then account menu → Link to Kosmy Board.',
  'Votre compte Crafty est désactivé.': 'Your Crafty account is disabled.',
  "Votre compte Crafty n'a pas les droits d'administration.": 'Your Crafty account does not have administrator rights.',
  "Changez d'abord le mot de passe provisoire de votre compte Crafty.": 'First change the temporary password of your Crafty account.',
  'Requête illisible.': 'Unreadable request.',
  // Vue d'ensemble
  "Vue d'ensemble": 'Overview',
  'En bref': 'At a glance',
  '{n} administrateur(s) actif(s)': '{n} active administrator(s)',
  'Comptes désactivés': 'Disabled accounts',
  'Sessions ouvertes': 'Open sessions',
  'Espace utilisé': 'Space used',
  'versions et corbeille comprises': 'including versions and trash',
  'Liens de partage actifs': 'Active share links',
  'liens de partage désactivés': 'share links disabled',
  'Instance': 'Instance',
  'Version de Crafty': 'Crafty version',
  'désactivée': 'off',
  'Sauvegarde automatique de la base': 'Automatic database backup',
  'toutes les {n} h': 'every {n} h',
  'Application': 'App',
  'Version': 'Version',
  'Aucune application.': 'No apps.',
  // Comptes
  'actif': 'active',
  'mot de passe': 'password',
  "Seuls les 500 premiers comptes sont affichés ici ; les autres sont dans l'administration de Crafty.":
    'Only the first 500 accounts are shown here; the others are in the Crafty administration.',
  '{name} (vous)': '{name} (you)',
  'Rendre administrateur': 'Make administrator',
  "Retirer les droits d'administration": 'Remove administrator rights',
  'Applications…': 'Apps…',
  'Sinon, seulement les applications cochées. La sélection actuelle est dans la colonne Applications ; un administrateur a toujours accès à toutes.':
    'Otherwise, only the checked apps. The current selection is in the Apps column; an administrator always has access to all of them.',
  'Quota…': 'Quota…',
  'Le compte ne pourra plus se connecter ; ses sessions sont fermées.': 'The account will no longer be able to sign in; its sessions are closed.',
  'Le compte, ses fichiers et leurs versions seront effacés. Cette action est définitive.': 'The account, its files and their versions will be erased. This cannot be undone.',
  'Aucun compte.': 'No accounts.',
  'Compte créé. Il faudra changer ce mot de passe à la première connexion.': 'Account created. This password must be changed at first sign-in.',
  'Mot de passe provisoire de {name}': 'Temporary password for {name}',
  "Cette action n'est pas possible pour ce compte.": 'This action is not possible for this account.',
  'Il devra le changer à sa première connexion.': 'It must be changed at the next sign-in.',
  // Réglages, assistant, système, journal
  'Applications des invités': 'Guest apps',
  'Utilisées seulement si le mode invité est activé.': 'Used only when guest mode is on.',
  'Sinon, seulement les comptes cochés ci-dessous.': 'Otherwise, only the accounts checked below.',
  'Essai': 'Test',
  'Connexion unique, secrets et sauvegardes.': 'Single sign-on, secrets and backups.',
  "L'émetteur, l'identifiant et le secret client se changent dans Crafty (Administration → Système) : les modifier d'ici couperait l'accès du Board.":
    'The issuer, client ID and client secret are changed in Crafty (Administration → System): changing them from here would cut off the Board’s access.',
  'Aucun événement.': 'No events.',
  'État : {state}': 'Status: {state}',
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
