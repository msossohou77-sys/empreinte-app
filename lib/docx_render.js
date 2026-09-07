// Rendu des modèles DOCX (voir cahier des charges, section 5.4).
// Contrairement aux modèles image/PSD (texte dessiné sur un calque à une position
// fixe), un modèle DOCX garde sa mise en page Word native : le PDF généré par
// LibreOffice est la sortie de référence, et sert aussi de base pour produire un
// PNG/JPEG (rasterisation de la première page) quand l'utilisateur préfère ce format.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HELPER = path.join(__dirname, 'docx_helper.py');
const { overlayPositionedFields } = require('./docx_overlay');

function extractFields(docxPath) {
  const out = execFileSync('python3', [HELPER, 'extract-fields', docxPath]).toString();
  return JSON.parse(out);
}

// Chaque appel utilise un profil LibreOffice temporaire dédié : sans cela, deux
// conversions concurrentes peuvent se bloquer mutuellement sur le même profil.
function convertToPdf(docxPath, outDir) {
  const profileDir = path.join(os.tmpdir(), 'lo_profile_' + crypto.randomUUID());
  fs.mkdirSync(profileDir, { recursive: true });
  try {
    execFileSync('soffice', [
      `-env:UserInstallation=file://${profileDir}`,
      '--headless', '--convert-to', 'pdf', '--outdir', outDir, docxPath
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
  const base = path.basename(docxPath, path.extname(docxPath));
  return path.join(outDir, base + '.pdf');
}

/**
 * @param {string} templatePath chemin du .docx source (avec {{champs}})
 * @param {Object} values { [fieldName]: string }  (par NOM de champ, pas par id — pour les champs {{...}})
 * @param {string} workDir dossier de travail temporaire
 * @param {Object} [options] { positionedFields, positionedValues } — champs ajoutés
 *   manuellement (texte/image/QR positionnés par glisser-déposer, comme pour les
 *   modèles image). positionedValues est indexé par ID de champ (pas par nom).
 * @returns {{ pdfBuffer: Buffer, pngBuffer: Buffer }}
 */
async function renderDocx(templatePath, values, workDir, options = {}) {
  fs.mkdirSync(workDir, { recursive: true });
  const id = crypto.randomUUID();
  const valuesPath = path.join(workDir, `values_${id}.json`);
  const filledDocxPath = path.join(workDir, `filled_${id}.docx`);
  const tempFiles = [valuesPath, filledDocxPath];

  try {
    fs.writeFileSync(valuesPath, JSON.stringify(values));
    execFileSync('python3', [HELPER, 'render', templatePath, valuesPath, filledDocxPath], { stdio: ['ignore', 'ignore', 'pipe'] });

    const pdfPath = convertToPdf(filledDocxPath, workDir);
    tempFiles.push(pdfPath);
    let pdfBuffer = fs.readFileSync(pdfPath);

    // Champs positionnés (ajoutés manuellement, avec x/y/w/h) : dessinés
    // par-dessus le PDF déjà généré, à l'endroit choisi par l'administrateur.
    if (options.positionedFields && options.positionedFields.length > 0) {
      pdfBuffer = await overlayPositionedFields(pdfBuffer, options.positionedFields, options.positionedValues || {});
    }

    const pngPrefix = path.join(workDir, `page_${id}`);
    const finalPdfPath = path.join(workDir, `final_${id}.pdf`);
    fs.writeFileSync(finalPdfPath, pdfBuffer);
    tempFiles.push(finalPdfPath);
    execFileSync('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', '1', finalPdfPath, pngPrefix], { stdio: ['ignore', 'ignore', 'ignore'] });
    const producedPng = fs.readdirSync(workDir).find(f => f.startsWith(`page_${id}`) && f.endsWith('.png'));
    const pngPath = path.join(workDir, producedPng);
    tempFiles.push(pngPath);
    const pngBuffer = fs.readFileSync(pngPath);

    return { pdfBuffer, pngBuffer };
  } finally {
    tempFiles.forEach(p => { try { fs.unlinkSync(p); } catch (e) { /* déjà absent */ } });
  }
}

module.exports = { extractFields, renderDocx };
