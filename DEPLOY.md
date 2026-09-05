# Déployer Empreinte sur Railway — guide pas à pas

Ce guide part du principe que tu n'as jamais déployé d'application avant. Chaque
étape est détaillée ; ça prend environ 20-30 minutes la première fois.

## Ce que tu vas obtenir à la fin

Une adresse publique du type `https://empreinte-production.up.railway.app`
accessible depuis n'importe quel appareil, où :
- Toi tu géreras tes modèles depuis `/admin`
- Tes utilisateurs finaux rempliront leurs documents via les liens publics
  générés — et ça fonctionnera vraiment pour eux, contrairement au prototype
  HTML à une seule page.

---

## Étape 1 — Mettre le code sur GitHub

Si ce n'est pas déjà fait :

1. Va sur **github.com** et connecte-toi (ou crée un compte gratuit)
2. Clique sur **"New repository"** (bouton vert, ou icône **+** en haut à droite → "New repository")
3. Donne-lui un nom, par exemple `empreinte-app`
4. Laisse-le en **Public** ou **Private** (les deux fonctionnent avec Railway), ne coche aucune case d'initialisation
5. Clique sur **"Create repository"**
6. Sur la page qui s'affiche, clique sur le lien **"uploading an existing file"**
7. **Décompresse le zip du projet sur ton ordinateur**, puis glisse-dépose **tout le contenu du dossier** `empreinte-mvp` (pas le dossier lui-même, son contenu : `server.js`, `lib/`, `public/`, `Dockerfile`, `package.json`, etc.) dans la zone d'upload de GitHub
8. Attends que l'upload se termine, puis clique sur **"Commit changes"** en bas de page

Ton code est maintenant sur GitHub. Le `Dockerfile` que je viens d'ajouter dit à
Railway exactement comment installer et lancer l'application.

---

## Étape 2 — Créer un compte Railway

1. Va sur **railway.app**
2. Clique sur **"Login"** puis **"Login with GitHub"** (le plus simple : ça relie
   directement ton compte GitHub, pas besoin de mot de passe séparé)
3. Autorise Railway à accéder à tes dépôts GitHub

Railway offre un crédit d'essai gratuit au départ, suffisant pour tester
tranquillement. Au-delà, c'est un tarif à l'usage — pour une petite application
comme celle-ci, compte quelques dollars par mois si elle tourne en continu.

---

## Étape 3 — Créer le projet

1. Sur le tableau de bord Railway, clique sur **"New Project"**
2. Choisis **"Deploy from GitHub repo"**
3. Sélectionne le dépôt `empreinte-app` que tu viens de créer
4. Railway détecte automatiquement le `Dockerfile` et commence la construction
   (icône avec un petit chargement) — **ça prend 3 à 6 minutes** la première
   fois (installation d'ImageMagick, LibreOffice, etc.)

Tu peux cliquer sur le service créé puis sur l'onglet **"Deployments"** pour
regarder les logs de construction en direct, comme un journal qui défile.

---

## Étape 4 — Générer une adresse publique

Par défaut, Railway ne donne pas d'URL accessible depuis l'extérieur.

1. Clique sur ton service (la carte avec le nom du projet)
2. Va dans l'onglet **"Settings"**
3. Descends jusqu'à la section **"Networking"**
4. Clique sur **"Generate Domain"**

Une adresse apparaît, du type `empreinte-app-production.up.railway.app`. C'est
ton application, en ligne, accessible par tout le monde. HTTPS est automatique.

---

## Étape 5 — Ajouter un espace de stockage permanent (important)

Sans cette étape, **tes modèles et documents générés seraient effacés à chaque
nouveau déploiement** (par exemple si tu modifies le code plus tard). Pour
l'éviter :

1. Dans ton service, va dans l'onglet **"Settings"**
2. Trouve la section **"Volumes"**, clique sur **"New Volume"**
3. Dans **"Mount path"**, écris exactement : `/app/data`
4. Choisis une petite taille pour commencer (1 Go suffit largement au départ,
   tu pourras l'augmenter plus tard)
5. Sauvegarde — Railway redémarre automatiquement le service

Ce volume correspond au dossier `data/` de l'application (là où sont stockés
`db.json`, les modèles importés et les documents générés).

---

## Étape 6 — (Facultatif) Configurer l'envoi d'e-mail

Si tu veux que l'app puisse envoyer les documents par e-mail (Phase 4) :

1. Toujours dans **Settings**, trouve la section **"Variables"**
2. Ajoute ces variables une par une (bouton **"New Variable"**) :

| Nom | Exemple de valeur |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `toncompte@gmail.com` |
| `SMTP_PASS` | *(un mot de passe d'application, pas ton mot de passe normal)* |
| `SMTP_FROM` | `toncompte@gmail.com` |

Pour Gmail, il faut générer un "mot de passe d'application" spécifique dans les
paramètres de sécurité de ton compte Google (recherche "mot de passe
d'application Google" si besoin — je peux t'accompagner si tu choisis cette
option).

Sans ces variables, l'application fonctionne normalement, simplement sans
l'option d'envoi par e-mail.

---

## Étape 7 — Se connecter et commencer

1. Ouvre `https://TON-ADRESSE.up.railway.app/admin`
2. Crée ton compte administrateur (le premier écran demandé)
3. Importe ton premier modèle, mappe les champs, publie un lien
4. Teste le lien public depuis **ton téléphone** (preuve que ça marche pour de
   vrai, pas juste dans ton propre navigateur comme le prototype HTML)

---

## Comment mettre à jour l'application plus tard

Si je t'aide à améliorer le code plus tard :

1. Remplace les fichiers modifiés dans ton dépôt GitHub (sur la page du fichier,
   crayon "Edit" en haut à droite, ou réupload du fichier)
2. Railway détecte automatiquement le changement et redéploie tout seul
   (quelques minutes d'attente, l'ancienne version reste en ligne pendant ce temps)

---

## Résumé des coûts

- **Railway** : crédit gratuit au départ, puis facturation à l'usage. Une petite
  app comme celle-ci, utilisée occasionnellement, coûte typiquement quelques
  dollars par mois.
- **Nom de domaine personnalisé** (optionnel, ex. `mesbadges.com` au lieu de
  `xxx.up.railway.app`) : environ 10-15€/an chez un registraire comme OVH,
  Namecheap ou Google Domains, puis à relier dans Railway (Settings → Networking
  → "Custom Domain").

---

## En cas de problème

- **Le build échoue** : regarde les logs dans l'onglet "Deployments" — l'erreur
  y est presque toujours expliquée en clair.
- **La page ne charge pas** : vérifie que tu as bien généré un domaine (Étape 4).
- **Les modèles disparaissent après une mise à jour** : le volume n'est
  probablement pas configuré correctement (Étape 5) — vérifie le "Mount path"
  exact : `/app/data`.

N'hésite pas à me montrer le message d'erreur exact si quelque chose bloque, je
t'aiderai à le résoudre.
