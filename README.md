# QuickNote Share

Bloc-notes temporaire, chiffré dans le navigateur et partageable par un simple lien.

Écrivez un message, choisissez sa durée de vie, puis envoyez le lien. La note est
détruite après sa première lecture, ou automatiquement à la fin du délai choisi
(1 heure, 24 heures ou 7 jours). Aucun compte, aucun mot de passe, aucun traqueur.

## Lancer le projet

Prérequis : **Node.js 22.13 ou supérieur** (SQLite intégré, sans drapeau expérimental).

```bash
npm start
```

Ou double-cliquez sur `start.bat` (pratique avec Laragon sous Windows).

Ouvrez ensuite [http://localhost:3000](http://localhost:3000).

> Utilisez `localhost` pour le développement : l'API Web Crypto, nécessaire au
> chiffrement, exige un contexte sécurisé (HTTPS ou localhost). En production,
> servez l'application derrière HTTPS.

## Configuration

| Variable      | Défaut      | Description                                              |
| ------------- | ----------- | -------------------------------------------------------- |
| `PORT`        | `3000`      | Port d'écoute                                            |
| `HOST`        | `127.0.0.1` | Interface d'écoute (`0.0.0.0` pour le réseau local)      |
| `DATA_DIR`    | `./data`    | Dossier de la base SQLite                                |
| `TRUST_PROXY` | `0`         | Passer à `1` derrière un reverse proxy de confiance      |

Exemple :

```bash
PORT=8080 HOST=0.0.0.0 npm start
```

## Fonctionnement

1. Le navigateur génère une clé AES-256 aléatoire.
2. Le message est chiffré en AES-GCM avant tout envoi.
3. Le serveur ne reçoit que le texte chiffré, le vecteur d'initialisation et
   l'empreinte SHA-256 de la clé.
4. La clé elle-même reste dans le fragment de l'URL (`#...`). Les fragments ne
   sont jamais envoyés au serveur.
5. À la révélation, le serveur vérifie l'empreinte de la clé puis supprime la
   note si elle est en mode « lecture unique ». Le navigateur déchiffre le
   contenu localement.

Le serveur ne peut donc jamais lire le contenu d'une note. Même en cas de fuite
de la base, les données restent illisibles sans les liens complets.

### Détails de sécurité

- Chiffrement **AES-256-GCM** avec un vecteur d'initialisation aléatoire de 96 bits.
- Empreinte de clé stockée côté serveur pour empêcher qu'un lien incomplet ne
  consomme ou ne révèle une note.
- Suppression physique logique immédiate en mode lecture unique (`secure_delete`).
- En-têtes de sécurité : CSP stricte, `X-Frame-Options: DENY`, `no-referrer`,
  `nosniff`, `noindex`.
- Limitation de débit sur la création et la révélation des notes.
- Taille maximale : 20 000 caractères, corps de requête limité, validation stricte.
- Aucun contenu de note n'est écrit dans les logs.
- Les notes « lecture unique » non lues ont une expiration de sécurité à 7 jours.

### Limites assumées

- Un lien complet donne accès à la note : ne le partagez qu'avec la bonne personne.
- La destruction côté serveur est immédiate à la première révélation. Le texte
  reste affiché quelques secondes dans le navigateur pour permettre la lecture,
  avec un compte à rebours de 60 secondes et un bouton « J'ai lu ».
- L'expiration à 7 jours des notes « lecture unique » évite l'accumulation de
  notes jamais ouvertes. Elle est affichée sur la page de lecture.
- Pour un déploiement public, ajoutez HTTPS, un reverse proxy et éventuellement
  une sauvegarde restreinte. La base ne contient de toute façon que du chiffré.

## API

| Méthode | Route                     | Description                                       |
| ------- | ------------------------- | ------------------------------------------------- |
| `POST`  | `/api/notes`              | Crée une note chiffrée                            |
| `GET`   | `/api/notes/:id`          | Retourne les métadonnées (sans le contenu)        |
| `POST`  | `/api/notes/:id/reveal`   | Vérifie la clé et retourne le contenu chiffré     |
| `GET`   | `/api/health`             | Vérification de disponibilité                     |

## Technologies

- Node.js, HTTP natif et SQLite (`node:sqlite`) — aucune dépendance npm.
- HTML/CSS/JavaScript vanilla.
- Web Crypto API (AES-GCM) pour le chiffrement côté client.
