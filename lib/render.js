// Moteur de rendu (voir cahier des charges, section 5.5).
// Le rendu est TOUJOURS recalculé côté serveur à partir du fichier source en pleine
// résolution : le navigateur ne fait qu'un aperçu approximatif, jamais le rendu final.

const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const { generateQrPng } = require('./qr');

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// data-uri base64 -> Buffer
function dataUriToBuffer(dataUri) {
  const match = /^data:(.+);base64,(.*)$/.exec(dataUri || '');
  if (!match) return null;
  return Buffer.from(match[2], 'base64');
}

/**
 * Construit le PNG final en haute résolution.
 * @param {string} templatePath chemin du fichier image source
 * @param {Array} fields liste des champs mappés (x,y,w,h,fontSize en fractions 0-1 de la largeur)
 * @param {Object} values { [fieldId]: string | dataUri }
 * @param {Object} [options] { qrValues: { [fieldId]: texte à encoder } } pour les champs type "qrcode"
 */
async function renderPng(templatePath, fields, values, options = {}) {
  const base = sharp(templatePath);
  const meta = await base.metadata();
  const W = meta.width, H = meta.height;

  const textFields = fields.filter(f => f.type === 'text');
  const imageFields = fields.filter(f => f.type === 'image');
  const qrFields = fields.filter(f => f.type === 'qrcode');

  // 1) Couche texte -> un unique SVG composité par-dessus le fond
  const textNodes = textFields.map(f => {
    const raw = values[f.id];
    const text = (raw !== undefined && raw !== '') ? raw : (f.sample || f.name);
    const fontSizePx = Math.max(6, Math.round(f.fontSize * W));
    const cx = f.x * W, cy = f.y * H;
    let anchor = 'middle', tx = cx;
    if (f.align === 'left') { anchor = 'start'; tx = cx - (f.w * W) / 2; }
    if (f.align === 'right') { anchor = 'end'; tx = cx + (f.w * W) / 2; }
    const ty = cy + fontSizePx * 0.35; // approx. centrage vertical sur la baseline
    return `<text x="${tx}" y="${ty}" font-size="${fontSizePx}" text-anchor="${anchor}" ` +
      `font-family="Georgia, 'Times New Roman', serif" fill="${escapeXml(f.color || '#23262F')}">` +
      `${escapeXml(text)}</text>`;
  }).join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${textNodes}</svg>`;

  const composites = [{ input: Buffer.from(svg), top: 0, left: 0 }];

  // 2) Champs image : redimensionnés puis composités individuellement
  for (const f of imageFields) {
    const val = values[f.id];
    const buf = dataUriToBuffer(val);
    if (!buf) continue;
    const w = Math.max(1, Math.round(f.w * W));
    const h = Math.max(1, Math.round(f.h * H));
    const resized = await sharp(buf).resize(w, h, { fit: 'cover' }).png().toBuffer();
    composites.push({
      input: resized,
      left: Math.round(f.x * W - w / 2),
      top: Math.round(f.y * H - h / 2)
    });
  }

  // 3) Champs QR code : générés dynamiquement (ex. lien de vérification par soumission),
  // jamais saisis par l'utilisateur final.
  const qrValues = options.qrValues || {};
  for (const f of qrFields) {
    const text = qrValues[f.id];
    if (!text) continue;
    const qrPng = generateQrPng(text);
    const size = Math.max(1, Math.round(f.w * W));
    const resized = await sharp(qrPng).resize(size, size, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
    composites.push({
      input: resized,
      left: Math.round(f.x * W - size / 2),
      top: Math.round(f.y * H - size / 2)
    });
  }

  return base.composite(composites).png().toBuffer();
}

async function pngToJpeg(pngBuffer) {
  return sharp(pngBuffer).flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer();
}

async function pngToPdf(pngBuffer) {
  const meta = await sharp(pngBuffer).metadata();
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(pngBuffer);
  const page = pdf.addPage([meta.width, meta.height]);
  page.drawImage(img, { x: 0, y: 0, width: meta.width, height: meta.height });
  return Buffer.from(await pdf.save());
}

module.exports = { renderPng, pngToJpeg, pngToPdf };
