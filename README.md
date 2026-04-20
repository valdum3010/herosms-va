# HeroSMS VA Dashboard

## Déploiement en 10 minutes sur Railway

### 1. Mettre le projet sur GitHub
1. Va sur github.com → "New repository" → nomme-le `herosms-va`
2. Upload tous les fichiers de ce dossier
3. **IMPORTANT** : le fichier `.env` ne doit PAS être uploadé (il est dans .gitignore)

### 2. Déployer sur Railway
1. Va sur railway.app → connecte-toi avec GitHub
2. "New Project" → "Deploy from GitHub repo" → sélectionne `herosms-va`
3. Railway détecte automatiquement Node.js et lance `npm start`

### 3. Configurer les variables d'environnement sur Railway
Dans Railway → ton projet → "Variables" → ajoute :

| Variable | Valeur |
|----------|--------|
| `HERO_API_KEY` | Ta clé API HeroSMS |
| `VA_PASSWORD` | Le mot de passe que tu choisis pour tes VAs |
| `ADMIN_PASSWORD` | Ton mot de passe admin |
| `MAX_PRICE` | `0.10` |

### 4. Accéder à l'appli
Railway te donne une URL du type : `https://herosms-va-production.up.railway.app`

- **VAs** → `https://ton-url.railway.app/` → rôle "VA" + mot de passe VA
- **Admin (toi)** → `https://ton-url.railway.app/` → rôle "Admin" + mot de passe admin

---

## Fonctionnement

### Côté VA
- Login avec le mot de passe commun
- 1 bouton "Acheter un numéro" → numéro US Instagram
- Le code SMS s'affiche automatiquement en grand
- Bouton "Annuler / Reset" si pas de code reçu (remboursement auto)
- Timer 20 min affiché en temps réel

### Côté Admin
- Voir combien de VAs sont connectés
- Voir qui a un numéro actif en cours
- Activer / Désactiver le bot pour tout le monde d'un clic
- Kick un VA si besoin

---

## Modifier les mots de passe
Modifie les variables d'environnement directement dans Railway → redéploiement automatique.
