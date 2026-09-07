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

/**
 * @param {Buffer} pdfBuffer PDF déjà généré (texte de substitution déjà rempli)
 * @param {Array} positionedFields champs avec x,y,w,h (fractions 0-1 de la page)
 * @param {Object} values { [fieldId]: string | dataUri }
 * @returns {Buffer} PDF avec les champs positionnés dessinés par-dessus
 */
async function overlayPositionedFields(pdfBuffer, positionedFields, values) {
  if (!positionedFields || positionedFields.length === 0) return pdfBuffer;

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const page = pdfDoc.getPages()[0];
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

  for (const f of positionedFields) {
    const cxPt = f.x * pageWidth;
    const cyTopPt = f.y * pageHeight; // repère "haut-gauche" façon image, en points

    if (f.type === 'text') {
      const raw = values[f.id];
      const text = (raw !== undefined && raw !== '') ? String(raw) : (f.sample || f.name);
      const sizePt = Math.max(6, f.fontSize * pageWidth);
      const textWidth = font.widthOfTextAtSize(text, sizePt);
      let xPt = cxPt - textWidth / 2;
      if (f.align === 'left') xPt = (f.x - f.w / 2) * pageWidth;
      if (f.align === 'right') xPt = (f.x + f.w / 2) * pageWidth - textWidth;
      const yPt = (pageHeight - cyTopPt) - sizePt * 0.35; // conversion vers l'origine bas-gauche
      page.drawText(text, { x: xPt, y: yPt, size: sizePt, font, color: hexToRgb01(f.color) });
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
  }

  return Buffer.from(await pdfDoc.save());
}

module.exports = { overlayPositionedFields };
