# Image de base légère avec Node.js déjà installé
FROM node:20-bookworm-slim

# --- Outils système nécessaires à l'import PSD/DOCX (Phase 2) ---
# imagemagick      : lecture des calques PSD
# python3 + pip     : détection/remplissage des champs DOCX, génération des QR codes
# libreoffice-writer : conversion DOCX -> PDF (version allégée, sans Impress/Calc)
# poppler-utils      : conversion PDF -> image
# fonts-dejavu-core / fontconfig : polices pour le texte dessiné sur les images
RUN apt-get update && apt-get install -y --no-install-recommends \
    imagemagick \
    python3 \
    python3-pip \
    libreoffice-writer \
    poppler-utils \
    fontconfig \
    fonts-dejavu-core \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Les polices "web-safe" choisies dans l'éditeur (Arial, Times New Roman, Courier
# New...) sont approximées par leurs équivalents libres métriquement compatibles
# (fonts-liberation), déjà installés ci-dessus.

# Les polices personnalisées uploadées par un administrateur (via l'API Local
# Font Access du navigateur) sont stockées dans data/fonts — donc sur le volume
# persistant, pas dans l'image — pour survivre aux redéploiements. On ajoute ce
# dossier à la liste scannée par fontconfig ; lib/fonts.js se charge ensuite de
# lancer `fc-cache` à chaque upload, sans jamais avoir besoin de redémarrer le
# serveur (vérifié).
RUN mkdir -p /app/data/fonts && \
    echo '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/app/data/fonts</dir></fontconfig>' \
    > /etc/fonts/conf.d/99-empreinte-data-fonts.conf

# ImageMagick limite par défaut la mémoire/le disque qu'il s'autorise à utiliser
# pour traiter une image (protection contre les fichiers piégés sur un serveur
# partagé). Sur NOTRE conteneur dédié, ces limites par défaut sont souvent trop
# basses pour un vrai fichier PSD Photoshop (calques multiples, haute résolution)
# et provoquent une erreur "cache resources exhausted". On les relève ici.
RUN for f in /etc/ImageMagick-6/policy.xml /etc/ImageMagick-7/policy.xml; do \
      if [ -f "$f" ]; then \
        sed -i -E 's/(name="memory" value=")[^"]*(")/\11GiB\2/' "$f"; \
        sed -i -E 's/(name="map" value=")[^"]*(")/\12GiB\2/' "$f"; \
        sed -i -E 's/(name="disk" value=")[^"]*(")/\14GiB\2/' "$f"; \
        sed -i -E 's/(name="width" value=")[^"]*(")/\140000\2/' "$f"; \
        sed -i -E 's/(name="height" value=")[^"]*(")/\140000\2/' "$f"; \
        sed -i -E 's/(name="area" value=")[^"]*(")/\11GP\2/' "$f"; \
      fi; \
    done

# Bibliothèques Python (déjà utilisées par lib/docx_helper.py et lib/qr_helper.py)
RUN pip3 install --no-cache-dir --break-system-packages python-docx reportlab

WORKDIR /app

# On copie d'abord package.json seul pour profiter du cache Docker : si le code
# change mais pas les dépendances, "npm install" n'est pas relancé inutilement.
COPY package.json ./
RUN npm install --omit=dev

# Reste du code de l'application
COPY . .

# Railway fournit automatiquement la variable PORT ; server.js la lit déjà
# (process.env.PORT || 3000), donc aucune modification de code n'est nécessaire.
EXPOSE 3000

CMD ["node", "server.js"]
