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
    && rm -rf /var/lib/apt/lists/*

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
