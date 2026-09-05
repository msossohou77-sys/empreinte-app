// Génération de QR codes dynamiques (cahier des charges, Phase 4).
// S'appuie sur le générateur QR pur Python déjà embarqué dans reportlab (aucune
// dépendance réseau nécessaire) — voir lib/qr_helper.py.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HELPER = path.join(__dirname, 'qr_helper.py');

/**
 * @param {string} text contenu encodé dans le QR (typiquement une URL de vérification)
 * @returns {Buffer} image PNG du QR code
 */
function generateQrPng(text) {
  const tmpPath = path.join(os.tmpdir(), `qr_${crypto.randomUUID()}.png`);
  try {
    execFileSync('python3', [HELPER, text, tmpPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    return fs.readFileSync(tmpPath);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (e) { /* déjà supprimé */ }
  }
}

module.exports = { generateQrPng };
