// Gestion des polices personnalisées (polices locales de l'appareil de
// l'administrateur, récupérées via l'API Local Font Access du navigateur).
//
// Les fichiers de police sont stockés dans data/fonts/ (donc sur le volume
// persistant, contrairement à /usr/share/fonts qui disparaîtrait à chaque
// redéploiement). Le Dockerfile ajoute /app/data/fonts aux dossiers scannés
// par fontconfig ; il suffit donc d'y écrire le fichier puis de lancer
// `fc-cache` pour qu'il soit immédiatement utilisable dans un rendu SVG
// (aucun redémarrage du serveur nécessaire — vérifié).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const db = require('./db');

function ensureFontsDir(fontsDir) {
  fs.mkdirSync(fontsDir, { recursive: true });
}

function extFromMime(mime) {
  if (/opentype|otf/.test(mime)) return '.otf';
  return '.ttf';
}

/**
 * Enregistre une police uploadée par l'administrateur et la rend disponible
 * immédiatement pour le rendu (fc-cache).
 */
function saveCustomFont(fontsDir, userId, family, dataUri) {
  const match = /^data:(.+);base64,(.*)$/.exec(dataUri || '');
  if (!match) throw new Error('Fichier de police invalide.');
  ensureFontsDir(fontsDir);
  const buffer = Buffer.from(match[2], 'base64');
  const id = crypto.randomUUID();
  const filename = id + extFromMime(match[1]);
  fs.writeFileSync(path.join(fontsDir, filename), buffer);

  try {
    execFileSync('fc-cache', ['-f', fontsDir], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    // Non bloquant : la police reste utilisable au prochain redémarrage même
    // si le rafraîchissement immédiat du cache a échoué pour une raison locale.
  }

  const record = { id, userId, family, filename, createdAt: new Date().toISOString() };
  db.insert('custom_fonts', record);
  return record;
}

function listCustomFonts(userId) {
  return db.filter('custom_fonts', f => f.userId === userId);
}

function deleteCustomFont(fontsDir, fontId, userId) {
  const font = db.find('custom_fonts', f => f.id === fontId && f.userId === userId);
  if (!font) return false;
  try { fs.unlinkSync(path.join(fontsDir, font.filename)); } catch (e) { /* déjà absent */ }
  db.replaceWhere('custom_fonts', f => f.id === fontId, []);
  return true;
}

module.exports = { saveCustomFont, listCustomFonts, deleteCustomFont, ensureFontsDir };
