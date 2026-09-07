// Découpe une image selon une forme donnée (cahier des charges — amélioration :
// respecter la forme du cadre photo, ex. un cercle pour une photo d'identité).
//
// Technique : on compose l'image avec un masque SVG (blend "dest-in", qui ne
// garde que les pixels de l'image là où le masque est opaque) — la façon
// standard de découper une forme avec sharp, qui n'a pas de primitive de
// découpe circulaire native.

const sharp = require('sharp');

/**
 * @param {Buffer} imageBuffer image déjà redimensionnée à w x h
 * @param {number} w largeur en pixels
 * @param {number} h hauteur en pixels
 * @param {'rect'|'circle'} shape
 * @returns {Buffer} PNG (avec transparence hors de la forme pour 'circle')
 */
async function clipToShape(imageBuffer, w, h, shape) {
  if (shape !== 'circle') {
    // Rectangle : aucune découpe nécessaire, on renvoie l'image telle quelle
    // (convertie en PNG pour un traitement uniforme par l'appelant).
    return sharp(imageBuffer).png().toBuffer();
  }
  const rx = w / 2, ry = h / 2;
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<ellipse cx="${rx}" cy="${ry}" rx="${rx}" ry="${ry}" fill="#fff"/></svg>`
  );
  return sharp(imageBuffer)
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

module.exports = { clipToShape };
