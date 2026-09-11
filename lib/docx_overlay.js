// Superpose des "champs positionnés" (texte, image ou QR code, placés librement
// par glisser-déposer, comme pour les modèles image/PSD) sur un PDF déjà généré
// par LibreOffice à partir d'un modèle Word.
//
// Un champ Word peut donc être de deux natures :
//   - un champ "texte de substitution" classique : une balise {{Nom}} déjà présente
//     dans le document, remplacée par python-docx (lib/docx_helper.py) avant la
//     conversion en PDF — la mise en page du document décide de son emplacement.
//   - un champ "positionné" (x, y, w, h renseignés, comme pour les modèles image) :
//     ajouté manuellement via "+ Ajouter un champ", dessiné par-dessus le PDF déjà
//     généré, à l'endroit choisi par l'administrateur.
//
// Les coordonnées du PDF ont pour origine le coin BAS-GAUCHE (axe Y vers le haut),
// contrairement à nos fractions x/y qui suivent la convention image (haut-gauche,
// Y vers le bas) : toutes les conversions ci-dessous en tiennent compte.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { generateQrPng } = require('./qr');
const { clipToShape } = require('./image_shape');
const sharp = require('sharp');

function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '23262F');
  if (!m) return rgb(0.14, 0.15, 0.18);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

function dataUriToBuffer(dataUri) {
  const match = /^data:(.+);base64,(.*)$/.exec(dataUri || '');
  if (!match) return null;
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
}

// Regroupe chaque police "web-safe" avec la famille des 14 polices standard PDF
// (toujours disponibles, aucun fichier à intégrer) la plus proche visuellement.
const STANDARD_GROUP_BY_FAMILY = {
  'Arial': 'Helvetica', 'Helvetica': 'Helvetica', 'Verdana': 'Helvetica',
  'Tahoma': 'Helvetica', 'Trebuchet MS': 'Helvetica',
  'Times New Roman': 'TimesRoman', 'Georgia': 'TimesRoman',
  'Courier New': 'Courier'
};
const STANDARD_FONTS = {
  Helvetica: { regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold, italic: StandardFonts.HelveticaOblique, boldItalic: StandardFonts.HelveticaBoldOblique },
  TimesRoman: { regular: StandardFonts.TimesRoman, bold: StandardFonts.TimesRomanBold, italic: StandardFonts.TimesRomanItalic, boldItalic: StandardFonts.TimesRomanBoldItalic },
  Courier: { regular: StandardFonts.Courier, bold: StandardFonts.CourierBold, italic: StandardFonts.CourierOblique, boldItalic: StandardFonts.CourierBoldOblique }
};
function styleKey(bold, italic) { return bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular'; }

/**
 * @param {Buffer} pdfBuffer PDF déjà généré (texte de substitution déjà rempli)
 * @param {Array} positionedFields champs avec x,y,w,h (fractions 0-1 de la page)
 * @param {Object} values { [fieldId]: string | dataUri }
 * @param {Object} [customFontFiles] { [nomDePolice]: Buffer } polices personnalisées
 *   uploadées par l'administrateur (Local Font Access), intégrées telles quelles
 *   dans le PDF via fontkit — voir lib/fonts.js pour leur stockage.
 * @returns {Buffer} PDF avec les champs positionnés dessinés par-dessus
 */
async function overlayPositionedFields(pdfBuffer, positionedFields, values, customFontFiles = {}) {
  if (!positionedFields || positionedFields.length === 0) return pdfBuffer;

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  // fontkit n'est chargé que si une police personnalisée est réellement utilisée
  // (embedFont avec un StandardFonts n'en a pas besoin) : le module reste
  // pleinement fonctionnel pour les polices web-safe même sans cette dépendance.
  const needsCustomFont = positionedFields.some(f => (f.type === 'text' || f.type === 'reference') && f.fontFamily && customFontFiles[f.fontFamily]);
  if (needsCustomFont) {
    const fontkit = require('@pdf-lib/fontkit');
    pdfDoc.registerFontkit(fontkit);
  }
  const page = pdfDoc.getPages()[0];
  const { width: pageWidth, height: pageHeight } = page.getSize();

  // Une police n'est intégrée qu'une seule fois même si plusieurs champs la
  // réutilisent (évite d'alourdir inutilement le PDF final).
  const fontCache = {};
  async function resolveFont(fontFamily, bold, italic) {
    const cacheKey = (fontFamily || '') + '|' + bold + '|' + italic;
    if (fontCache[cacheKey]) return fontCache[cacheKey];

    let embedded;
    if (fontFamily && customFontFiles[fontFamily]) {
      // Police personnalisée : le fichier ne contient généralement qu'une seule
      // graisse/style, mais on l'utilise quoi qu'il arrive — c'est la police
      // exacte choisie par l'administrateur qui prime sur un gras/italique simulé.
      embedded = await pdfDoc.embedFont(customFontFiles[fontFamily], { subset: true });
    } else {
      const group = STANDARD_GROUP_BY_FAMILY[fontFamily] || 'TimesRoman';
      embedded = await pdfDoc.embedFont(STANDARD_FONTS[group][styleKey(bold, italic)]);
    }
    fontCache[cacheKey] = embedded;
    return embedded;
  }

  for (const f of positionedFields) {
    const cxPt = f.x * pageWidth;
    const cyTopPt = f.y * pageHeight; // repère "haut-gauche" façon image, en points

    if (f.type === 'text' || f.type === 'reference') {
      const raw = values[f.id];
      const text = (raw !== undefined && raw !== '') ? String(raw) : (f.sample || f.name);
      const sizePt = Math.max(6, f.fontSize * pageWidth);
      const font = await resolveFont(f.fontFamily, f.bold, f.italic);
      const textWidth = font.widthOfTextAtSize(text, sizePt);
      let xPt = cxPt - textWidth / 2;
      if (f.align === 'left') xPt = (f.x - f.w / 2) * pageWidth;
      if (f.align === 'right') xPt = (f.x + f.w / 2) * pageWidth - textWidth;
      const yPt = (pageHeight - cyTopPt) - sizePt * 0.35; // conversion vers l'origine bas-gauche
      const color = hexToRgb01(f.color);
      page.drawText(text, { x: xPt, y: yPt, size: sizePt, font, color });
      if (f.underline) {
        const underlineY = yPt - sizePt * 0.08;
        page.drawLine({ start: { x: xPt, y: underlineY }, end: { x: xPt + textWidth, y: underlineY }, thickness: Math.max(0.5, sizePt * 0.05), color });
      }
      continue;
    }

    // Champs image ou QR code : mêmes calculs de position/taille, seule la
    // source de l'image diffère.
    let wPt = f.w * pageWidth;
    let hPt = f.h * pageHeight;
    if (f.type === 'image' && f.shape === 'circle') {
      // Un cercle doit rester un cercle même si la case n'est pas carrée : on
      // prend le plus petit des deux côtés comme diamètre.
      wPt = hPt = Math.min(wPt, hPt);
    }
    const xPt = cxPt - wPt / 2;
    const yPt = (pageHeight - cyTopPt) - hPt / 2; // coin bas-gauche de l'image

    let embedded = null;
    if (f.type === 'image') {
      const parsed = dataUriToBuffer(values[f.id]);
      if (parsed) {
        // Redimensionnée puis découpée à la forme choisie (cercle, etc.) AVANT
        // d'être intégrée au PDF — pdf-lib n'a pas de découpe de forme native,
        // mais respecte la transparence d'un PNG, d'où le passage par sharp ici.
        const pxW = Math.max(1, Math.round(wPt * 2));
        const pxH = Math.max(1, Math.round(hPt * 2));
        const resized = await sharp(parsed.buffer).resize(pxW, pxH, { fit: 'cover' }).png().toBuffer();
        const shaped = await clipToShape(resized, pxW, pxH, f.shape);
        embedded = await pdfDoc.embedPng(shaped);
      }
    } else if (f.type === 'qrcode') {
      const qrText = values[f.id];
      if (qrText) embedded = await pdfDoc.embedPng(generateQrPng(qrText));
    }
    if (embedded) page.drawImage(embedded, { x: xPt, y: yPt, width: wPt, height: hPt });

    // Bordure du cadre photo (facultative), uniquement pour les champs image.
    if (f.type === 'image' && f.borderEnabled) {
      const borderWidthPt = Math.max(0.5, (f.borderWidth || 0.006) * pageWidth);
      const borderColor = hexToRgb01(f.borderColor || '#1B2340');
      if (f.shape === 'circle') {
        page.drawEllipse({
          x: xPt + wPt / 2, y: yPt + hPt / 2,
          xScale: Math.max(0, wPt / 2 - borderWidthPt / 2), yScale: Math.max(0, hPt / 2 - borderWidthPt / 2),
          borderColor, borderWidth: borderWidthPt
        });
      } else {
        page.drawRectangle({
          x: xPt + borderWidthPt / 2, y: yPt + borderWidthPt / 2,
          width: Math.max(0, wPt - borderWidthPt), height: Math.max(0, hPt - borderWidthPt),
          borderColor, borderWidth: borderWidthPt
        });
      }
    }
  }

  return Buffer.from(await pdfDoc.save());
}

module.exports = { overlayPositionedFields };
