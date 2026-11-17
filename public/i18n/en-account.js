// Traductions anglaises : compte (double authentification, Dashy), connexion en deux étapes, administration → Système.
// Fichiers : account.js, admin-system.js, et les ajouts correspondants de login.js, ui.js, admin.js, admin.html.
export default {
  // account.js : Dashy
  'Compte Dashy lié : vous pouvez maintenant vous connecter avec Dashy.': 'Dashy account linked: you can now sign in with Dashy.',
  "La connexion Dashy a expiré ou vient d'un autre onglet : recommencez.": 'The Dashy sign-in expired or came from another tab: please try again.',
  'Le jeton de Dashy a expiré : recommencez.': 'The Dashy token expired: please try again.',
  'Ce lien de connexion a déjà servi : recommencez.': 'This sign-in link was already used: please try again.',
  "Aucun compte Crafty n'est lié à cette identité Dashy : demandez à l'administrateur.": 'No Crafty account is linked to this Dashy identity: ask your administrator.',
  'Ce compte est désactivé.': 'This account is disabled.',
  'Trop de tentatives, réessayez dans une minute.': 'Too many attempts. Try again in a minute.',
  'Cette identité Dashy est déjà liée à un autre compte.': 'This Dashy identity is already linked to another account.',
  'Votre compte est déjà lié à une identité Dashy.': 'Your account is already linked to a Dashy identity.',
  'Session expirée : reconnectez-vous puis recommencez.': 'Session expired: sign in again, then try again.',
  'Jeton de Dashy refusé : la configuration SSO est à vérifier.': 'Dashy token refused: the SSO configuration needs checking.',
  'Liaison avec Dashy impossible': 'Could not link with Dashy',

  // account.js : double authentification
  'Double authentification': 'Two-factor authentication',
  "En plus du mot de passe, la connexion demandera un code à 6 chiffres donné par une application d'authentification (Aegis, Google Authenticator, 1Password, Bitwarden…).":
    'Besides your password, signing in will ask for a 6-digit code from an authenticator app (Aegis, Google Authenticator, 1Password, Bitwarden…).',
  'Continuer': 'Continue',
  "1. Scannez ce QR code avec l'application d'authentification.": '1. Scan this QR code with your authenticator app.',
  "QR code à scanner avec l'application d'authentification": 'QR code to scan with your authenticator app',
  'Saisie manuelle de la clé': 'Enter the key manually',
  "2. Code à 6 chiffres affiché par l'application": '2. 6-digit code shown by the app',
  'Activer': 'Turn on',
  'Double authentification activée.': 'Two-factor authentication is on.',
  "Codes de secours Crafty (chacun ne sert qu'une fois) :": 'Crafty recovery codes (each works only once):',
  'Télécharger (.txt)': 'Download (.txt)',
  "Gardez ces codes en lieu sûr (gestionnaire de mots de passe, papier). Chacun remplace une fois le code de l'application si vous perdez votre téléphone. Ils ne seront plus affichés.":
    'Keep these codes somewhere safe (password manager, paper). Each one replaces the app code once if you lose your phone. They will not be shown again.',
  "J'ai noté mes codes": "I've saved my codes",
  "Code de l'application (ou code de secours)": 'App code (or recovery code)',
  'Active': 'On',
  "La connexion demande un code de l'application d'authentification.": 'Signing in asks for a code from your authenticator app.',
  '1 code de secours restant.': '1 recovery code left.',
  '{n} codes de secours restants.': '{n} recovery codes left.',
  'Les anciens codes de secours ne fonctionneront plus.': 'The old recovery codes will stop working.',
  'Nouveaux codes de secours…': 'New recovery codes…',
  'La connexion ne demandera plus que le mot de passe.': 'Signing in will only ask for your password.',
  'Double authentification désactivée.': 'Two-factor authentication is off.',
  'Désactiver…': 'Turn off…',

  // login.js
  'Se connecter avec Dashy': 'Sign in with Dashy',
  'Code de vérification': 'Verification code',
  "Saisissez le code à 6 chiffres affiché par votre application d'authentification.": 'Enter the 6-digit code shown by your authenticator app.',
  'Code': 'Code',
  'Téléphone perdu ? Saisissez un de vos codes de secours (xxxxx-xxxxx).': 'Lost your phone? Enter one of your recovery codes (xxxxx-xxxxx).',
  'Vérifier': 'Verify',
  'Indiquez le code.': 'Enter the code.',

  // ui.js : menu du compte
  'Double authentification (active)': 'Two-factor authentication (on)',
  'Double authentification…': 'Two-factor authentication…',
  'Lier mon compte Dashy': 'Link my Dashy account',

  // admin.js
  'Retirer la double authentification…': 'Remove two-factor authentication…',
  'Délier de Dashy': 'Unlink from Dashy',
  'Compte délié de Dashy.': 'Account unlinked from Dashy.',
  'double authentification': 'two-factor',
  'lié à Dashy': 'linked to Dashy',
  'Dashy seulement': 'Dashy only',
  'Retirer la double authentification de {name} ?': 'Remove two-factor authentication from {name}?',
  'Retirer': 'Remove',
  'À faire seulement si la personne a perdu son téléphone et ses codes de secours, après avoir vérifié son identité. Elle pourra la réactiver depuis son compte.':
    'Only do this if the person lost both their phone and their recovery codes, after checking who they are. They can turn it on again from their account.',
  'Double authentification retirée.': 'Two-factor authentication removed.',
  'Comptes créés par Dashy': 'Accounts created by Dashy',
  "Une identité Dashy inconnue obtient un compte Crafty à sa première connexion (administrateur si elle l'est dans Dashy). Sinon, seuls les comptes déjà liés peuvent se connecter avec Dashy.":
    'An unknown Dashy identity gets a Crafty account the first time it signs in (an administrator if it is one in Dashy). Otherwise, only accounts already linked can sign in with Dashy.',
  'Double authentification activée': 'Two-factor authentication turned on',
  'Double authentification désactivée': 'Two-factor authentication turned off',
  'Codes de secours renouvelés': 'Recovery codes renewed',
  'Connexion par Dashy': 'Sign-in with Dashy',
  'Compte créé par Dashy': 'Account created by Dashy',
  'Compte lié à Dashy': 'Account linked to Dashy',

  // admin.html, admin-system.js
  'Système': 'System',
  'Réseau, connexion unique, secrets et sauvegardes.': 'Network, single sign-on, secrets and backups.',
  'Correct': 'Correct',
  "L'adresse retenue est celle que Cloudflare a reçue du visiteur.": 'The address used is the one Cloudflare received from the visitor.',
  'À corriger': 'Needs fixing',
  "L'adresse retenue n'est pas celle du visiteur (CF-Connecting-IP) : ajustez TRUST_PROXY (nombre de proxys entre le visiteur et Crafty) et la confiance de Traefik envers Cloudflare.":
    "The address used is not the visitor's (CF-Connecting-IP): adjust TRUST_PROXY (number of proxies between the visitor and Crafty) and Traefik's trust in Cloudflare.",
  'À confirmer': 'To confirm',
  "Un proxy transmet X-Forwarded-For et il est pris en compte : comparez l'adresse retenue avec votre adresse publique.":
    'A proxy sends X-Forwarded-For and it is trusted: compare the address used with your public address.',
  "Un proxy transmet X-Forwarded-For mais TRUST_PROXY l'ignore : toutes les connexions semblent venir du proxy (limites par IP et fail2ban communs à tous).":
    'A proxy sends X-Forwarded-For but TRUST_PROXY ignores it: every connection seems to come from the proxy (per-IP limits and fail2ban shared by everyone).',
  'Connexion directe': 'Direct connection',
  "Aucun proxy : l'adresse retenue est celle de la connexion.": 'No proxy: the address used is the connection’s own.',
  'Adresse retenue': 'Address used',
  'Chaîne (proxys de confiance)': 'Chain (trusted proxies)',
  'Connexion reçue de': 'Connection received from',
  'HTTPS vu par le serveur': 'HTTPS as seen by the server',
  'oui': 'yes',
  'non': 'no',
  'Vérification impossible': 'Check failed',
  'Adresse IP réelle': 'Real IP address',
  "Les limites de connexion, le verrouillage et fail2ban se fondent sur cette adresse. Ouvrez cette page depuis l'extérieur (par le domaine public) pour vérifier.":
    'Sign-in limits, lockout and fail2ban rely on this address. Open this page from outside (through the public domain) to check it.',
  'Vérifier à nouveau': 'Check again',
  'État': 'Status',
  'activée': 'on',
  'Dashy': 'Dashy',
  'Adresse de retour à autoriser dans Dashy': 'Return address to allow in Dashy',
  "Désactivée. Pour l'activer : SSO_SHARED_SECRET (le même que dans Dashy), SSO_DASHY_URL et PUBLIC_ORIGIN dans l'environnement du conteneur (docs/DEPLOIEMENT.md).":
    "Off. To turn it on: SSO_SHARED_SECRET (the same as in Dashy), SSO_DASHY_URL and PUBLIC_ORIGIN in the container's environment (docs/DEPLOIEMENT.md).",
  'Instantané': 'Snapshot',
  'Taille': 'Size',
  "Aucun instantané pour l'instant.": 'No snapshot yet.',
  'Connexion unique (Dashy)': 'Single sign-on (Dashy)',
  'Secrets': 'Secrets',
  "Clés des fournisseurs d'IA et secrets de double authentification chiffrés avec CRAFTY_SECRET.": 'AI provider keys and two-factor secrets are encrypted with CRAFTY_SECRET.',
  'en clair': 'unencrypted',
  "CRAFTY_SECRET n'est pas défini : clés d'IA et secrets de double authentification sont gardés en clair dans la base.":
    'CRAFTY_SECRET is not set: AI keys and two-factor secrets are stored unencrypted in the database.',
  'Sauvegardes de la base': 'Database backups',
  'Instantané automatique toutes les {n} h dans DATA_DIR/backups (à copier hors du serveur avec le reste du volume).':
    'Automatic snapshot every {n} h in DATA_DIR/backups (copy it off the server with the rest of the volume).',
  'Instantané automatique désactivé (BACKUP_EVERY_HOURS). À la main : node scripts/backup.mjs': 'Automatic snapshot off (BACKUP_EVERY_HOURS). By hand: node scripts/backup.mjs',
};
