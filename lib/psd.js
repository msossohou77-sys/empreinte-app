// Import "intelligent" des fichiers PSD (voir cahier des charges, section 5.3).
//
// Approche retenue (sans bibliothèque PSD dédiée, indisponible hors-ligne) :
//   - ImageMagick (déjà présent sur le système) sait lire un PSD calque par calque
//     (chaque calque = une "frame") et restitue le nom du calque via son attribut
//     "label" lorsque celui-ci a été renseigné dans Photoshop.
//   - Le calque de fond (souvent le calque "Background" verrouillé de Photoshop)
//     n'a pas de label : on l'exclut donc automatiquement des champs proposés.
//   - Pour chaque calque nommé, on extrait son image en conservant la transparence,
//     puis on calcule la zone réellement dessinée (bounding box du canal alpha) avec
//     sharp : cela donne la position et la taille du champ, sans intervention manuelle.
//   - La couleur moyenne des pixels de ce calque est utilisée comme couleur par défaut
//     du champ (pratique quand le designer a déjà positionné un texte de la bonne teinte).
//
// Limite assumée (documentée au cahier des charges) : le contenu textuel réel et la
// police d'un calque texte Photoshop ne sont pas récupérés (ImageMagick les rasterise).
// L'administrateur peut ajuster nom, type et style après l'import automatique.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Exécute une commande ImageMagick en remontant le VRAI message d'erreur (sa
// sortie stderr) plutôt que le message générique de Node ("Command failed with
// exit code 1"), qui ne dit jamais pourquoi ça a échoué.
function runImageMagick(cmd, args) {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const stderrText = (e.stderr ? e.stderr.toString() : '').trim();
    const reason = stderrText || e.message;
    throw new Error(reason.slice(0, 500));
  }
}

function countLayers(psdPath) {
  const out = runImageMagick('identify', [psdPath]).toString().trim();
  return out.split('\n').filter(Boolean).length;
}

function layerLabel(psdPath, index) {
  try {
    return execFileSync('identify', ['-format', '%[label]', `${psdPath}[${index}]`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) {
    return '';
  }
}

function extractLayerToPng(psdPath, index, outPath) {
  runImageMagick('convert', [`${psdPath}[${index}]`, '-alpha', 'on', `PNG32:${outPath}`]);
}

async function analyzeLayerPixels(pngPath) {
  const img = sharp(pngPath).ensureAlpha();
  const { width, height } = await img.metadata();
  const raw = await img.raw().toBuffer();
  const ALPHA_THRESHOLD = 20;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  let rSum = 0, gSum = 0, bSum = 0, count = 0;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x * 4;
      const a = raw[idx + 3];
      if (a > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        rSum += raw[idx]; gSum += raw[idx + 1]; bSum += raw[idx + 2]; count++;
      }
    }
  }
  if (count === 0) return null;

  const toHex = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  const color = `#${toHex(rSum / count)}${toHex(gSum / count)}${toHex(bSum / count)}`;
  const bbox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  const coverage = (bbox.w * bbox.h) / (width * height);
  return { bbox, canvasWidth: width, canvasHeight: height, color, coverage };
}

function guessFieldType(label) {
  const l = label.toLowerCase();
  if (/photo|image|logo|portrait|avatar/.test(l)) return 'image';
  return 'text';
}

/**
 * Analyse un PSD et retourne :
 *  - backgroundPngPath : image de fond à utiliser comme le fait un modèle "image"
 *    classique (le pipeline de rendu existant est réutilisé tel quel). Important :
 *    ce fond ne contient QUE les calques non nommés (le "vrai" fond graphique) —
 *    les calques nommés (futurs champs) en sont exclus, pour ne pas laisser un
 *    texte ou une photo de substitution transparaître sous la valeur saisie par
 *    l'utilisateur final.
 *  - fields : liste de champs pré-positionnés, prêts à être enregistrés puis ajustés
 */
async function analyzePsd(psdPath, workDir) {
  fs.mkdirSync(workDir, { recursive: true });

  const total = countLayers(psdPath);
  const backgroundLayerPngs = [];
  const fields = [];
  let canvasWidth = null, canvasHeight = null;

  for (let i = 0; i < total; i++) {
    const label = layerLabel(psdPath, i);
    const layerPngPath = path.join(workDir, `layer_${i}.png`);
    extractLayerToPng(psdPath, i, layerPngPath);

    if (!canvasWidth) {
      const meta = await sharp(layerPngPath).metadata();
      canvasWidth = meta.width; canvasHeight = meta.height;
    }

    if (!label) {
      // Calque non nommé (typiquement le fond / "Background" verrouillé) : conservé
      // tel quel dans l'image de fond, jamais proposé comme champ.
      backgroundLayerPngs.push(layerPngPath);
      continue;
    }

    const analysis = await analyzeLayerPixels(layerPngPath);
    if (!analysis) { fs.unlinkSync(layerPngPath); continue; }
    // Un calque nommé qui couvre la quasi-totalité du canevas ressemble davantage à
    // un fond décoratif qu'à un champ à personnaliser : on l'ignore comme champ,
    // mais on le garde dans le fond (il fait partie du décor). Sinon, on n'a plus
    // besoin de ce fichier temporaire.
    if (analysis.coverage > 0.85) { backgroundLayerPngs.push(layerPngPath); continue; }
    fs.unlinkSync(layerPngPath);

    const { bbox, color } = analysis;
    const type = guessFieldType(label);
    fields.push({
      name: label,
      type,
      x: (bbox.x + bbox.w / 2) / canvasWidth,
      y: (bbox.y + bbox.h / 2) / canvasHeight,
      w: bbox.w / canvasWidth,
      h: bbox.h / canvasHeight,
      fontSize: type === 'text' ? Math.min(0.12, Math.max(0.012, (bbox.h * 0.75) / canvasWidth)) : 0,
      color,
      align: 'center',
      sample: label
    });
  }

  const backgroundPngPath = path.join(workDir, 'background.png');
  if (backgroundLayerPngs.length > 0) {
    let composite = sharp(backgroundLayerPngs[0]);
    if (backgroundLayerPngs.length > 1) {
      composite = composite.composite(backgroundLayerPngs.slice(1).map(p => ({ input: p })));
    }
    await composite.png().toFile(backgroundPngPath);
  } else {
    // Cas limite : aucun calque non nommé (tout est mappé). On part d'un fond blanc.
    await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 3, background: '#ffffff' } })
      .png().toFile(backgroundPngPath);
  }
  backgroundLayerPngs.forEach(p => { try { fs.unlinkSync(p); } catch (e) { /* déjà supprimé */ } });

  return { backgroundPngPath, width: canvasWidth, height: canvasHeight, fields };
}

module.exports = { analyzePsd };
