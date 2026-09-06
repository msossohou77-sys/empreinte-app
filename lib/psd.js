// Import "intelligent" des fichiers PSD (voir cahier des charges, section 5.3).
//
// Approche retenue (sans bibliothèque PSD dédiée, indisponible hors-ligne) :
//   - ImageMagick (déjà présent sur le système) sait lire un PSD calque par calque
//     (chaque calque = une "frame") et restitue le nom du calque via son attribut
//     "label" lorsque celui-ci a été renseigné dans Photoshop.
//   - IMPORTANT : ImageMagick extrait chaque calque RECADRÉ à son propre contenu
//     (ex. un calque de 150x100px positionné à 300,200 sur un canevas de 800x500
//     est exporté en 150x100px, PAS en 800x500px). On lit donc la position réelle
//     de chaque calque séparément (geometry ImageMagick), et la taille véritable du
//     canevas directement depuis l'en-tête binaire du fichier PSD (fiable, ne dépend
//     d'aucun calque en particulier).
//   - Le calque de fond (souvent le calque "Background" verrouillé de Photoshop)
//     n'a pas de label : on l'exclut donc automatiquement des champs proposés.
//   - Pour chaque calque nommé, on calcule la zone réellement dessinée (bounding box
//     du canal alpha) avec sharp, qu'on replace ensuite dans les coordonnées du
//     canevas entier : cela donne la position et la taille du champ, automatiquement.
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

// Lit la largeur/hauteur du document directement dans l'en-tête binaire du
// fichier PSD (format documenté par Adobe : signature "8BPS" puis hauteur et
// largeur en 4 octets chacune). Fiable quel que soit le contenu des calques.
function readPsdCanvasSize(psdPath) {
  const fd = fs.openSync(psdPath, 'r');
  const buf = Buffer.alloc(26);
  fs.readSync(fd, buf, 0, 26, 0);
  fs.closeSync(fd);
  const signature = buf.toString('ascii', 0, 4);
  if (signature !== '8BPS') throw new Error("Ce fichier ne semble pas être un PSD valide (signature d'en-tête absente).");
  return { height: buf.readUInt32BE(14), width: buf.readUInt32BE(18) };
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

// Position et taille RÉELLES du calque sur le canevas (pas seulement sa propre
// taille recadrée) : ImageMagick expose ça via %w/%h (dimensions) et %X/%Y
// (décalage depuis le coin supérieur gauche du document).
function layerGeometry(psdPath, index) {
  const out = execFileSync('identify', ['-format', '%w,%h,%X,%Y', `${psdPath}[${index}]`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const [w, h, x, y] = out.split(',').map(Number);
  return { width: w, height: h, offsetX: Number.isFinite(x) ? x : 0, offsetY: Number.isFinite(y) ? y : 0 };
}

function extractLayerToPng(psdPath, index, outPath) {
  runImageMagick('convert', [`${psdPath}[${index}]`, '-alpha', 'on', `PNG32:${outPath}`]);
}

// Bounding box + couleur moyenne des pixels non transparents, DANS LE REPÈRE DE
// L'IMAGE EXTRAITE (donc potentiellement déjà recadrée à son propre contenu).
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
  const localBbox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  return { localBbox, imgWidth: width, imgHeight: height, color };
}

function guessFieldType(label) {
  const l = label.toLowerCase();
  if (/photo|image|logo|portrait|avatar/.test(l)) return 'image';
  return 'text';
}

/**
 * Analyse un PSD et retourne :
 *  - backgroundPngPath : image de fond, taille du canevas complet, à utiliser
 *    comme le fait un modèle "image" classique (le pipeline de rendu existant
 *    est réutilisé tel quel). Ce fond ne contient QUE les calques non nommés
 *    (le "vrai" fond graphique) — les calques nommés (futurs champs) en sont
 *    exclus, pour ne pas laisser un texte ou une photo de substitution
 *    transparaître sous la valeur saisie par l'utilisateur final.
 *  - fields : liste de champs pré-positionnés (en coordonnées du canevas
 *    entier, pas du calque recadré), prêts à être enregistrés puis ajustés.
 */
async function analyzePsd(psdPath, workDir) {
  fs.mkdirSync(workDir, { recursive: true });

  const { width: canvasWidth, height: canvasHeight } = readPsdCanvasSize(psdPath);
  const total = countLayers(psdPath);
  // { path, offsetX, offsetY } pour chaque calque destiné au fond.
  const backgroundLayers = [];
  const fields = [];

  for (let i = 0; i < total; i++) {
    let label, geo;
    try {
      label = layerLabel(psdPath, i);
      geo = layerGeometry(psdPath, i);
    } catch (e) {
      continue; // calque illisible (ex. groupe de calques) : on l'ignore plutôt que d'échouer
    }
    if (geo.width <= 0 || geo.height <= 0) continue; // calque vide (ex. calque de réglage)

    const layerPngPath = path.join(workDir, `layer_${i}.png`);
    try {
      extractLayerToPng(psdPath, i, layerPngPath);
    } catch (e) {
      continue; // ce calque précis pose problème : on continue avec les autres
    }

    // Un calque non nommé (typiquement le fond) est conservé tel quel dans le
    // fond, à sa position réelle sur le canevas.
    if (!label) {
      backgroundLayers.push({ path: layerPngPath, offsetX: geo.offsetX, offsetY: geo.offsetY, width: geo.width, height: geo.height });
      continue;
    }

    const analysis = await analyzeLayerPixels(layerPngPath);
    if (!analysis) { fs.unlinkSync(layerPngPath); continue; }

    // Coverage basée sur le contenu RÉELLEMENT dessiné (bounding box du canal
    // alpha), pas sur la taille du cadre du calque — un calque de texte est
    // souvent stocké par Photoshop dans un cadre de la taille du canevas entier
    // même si le texte lui-même n'en occupe qu'une petite partie.
    const coverage = (analysis.localBbox.w * analysis.localBbox.h) / (canvasWidth * canvasHeight);
    if (coverage > 0.85) {
      // Ressemble à un fond décoratif plutôt qu'à un champ : on le garde dans le
      // fond plutôt que de le proposer comme champ mappable.
      backgroundLayers.push({ path: layerPngPath, offsetX: geo.offsetX, offsetY: geo.offsetY, width: geo.width, height: geo.height });
      continue;
    }
    fs.unlinkSync(layerPngPath);

    // On repasse du repère local (dans l'image recadrée) au repère du canevas
    // entier en ajoutant le décalage du calque.
    const { localBbox, color } = analysis;
    const absX = geo.offsetX + localBbox.x;
    const absY = geo.offsetY + localBbox.y;
    const type = guessFieldType(label);
    // Sécurité : un champ dont le contenu réel déborderait légèrement du canevas
    // (rare, mais possible avec un calque texte proche du bord) est ramené dans
    // les limites du document pour éviter un champ mal positionné.
    const clamp01 = v => Math.max(0, Math.min(1, v));
    fields.push({
      name: label,
      type,
      x: clamp01((absX + localBbox.w / 2) / canvasWidth),
      y: clamp01((absY + localBbox.h / 2) / canvasHeight),
      w: Math.min(1, localBbox.w / canvasWidth),
      h: Math.min(1, localBbox.h / canvasHeight),
      fontSize: type === 'text' ? Math.min(0.12, Math.max(0.012, (localBbox.h * 0.75) / canvasWidth)) : 0,
      color,
      align: 'center',
      sample: label
    });
  }

  const backgroundPngPath = path.join(workDir, 'background.png');
  // On part toujours d'un canevas transparent à la VRAIE taille du document, sur
  // lequel chaque calque de fond est composité à sa position réelle. Un calque
  // Photoshop déborde très souvent du canevas (ombre portée, fond à fond perdu,
  // décalage négatif...) : sharp refuse de compositer un élément plus grand que
  // la base, même en précisant sa position. On recadre donc chaque calque à la
  // seule portion réellement visible sur le canevas avant de l'assembler.
  const compositeOps = [];
  for (const l of backgroundLayers) {
    const srcLeft = Math.max(0, -l.offsetX);
    const srcTop = Math.max(0, -l.offsetY);
    const destLeft = Math.max(0, l.offsetX);
    const destTop = Math.max(0, l.offsetY);
    const visibleWidth = Math.min(l.offsetX + l.width, canvasWidth) - destLeft;
    const visibleHeight = Math.min(l.offsetY + l.height, canvasHeight) - destTop;

    if (visibleWidth <= 0 || visibleHeight <= 0) continue; // calque entièrement hors du canevas

    if (srcLeft === 0 && srcTop === 0 && visibleWidth === l.width && visibleHeight === l.height) {
      // Cas le plus courant : le calque tient déjà entièrement dans le canevas.
      compositeOps.push({ input: l.path, left: destLeft, top: destTop });
    } else {
      // Le calque déborde : on ne garde que la portion visible.
      const croppedPath = l.path.replace(/\.png$/, '_cropped.png');
      await sharp(l.path).extract({ left: srcLeft, top: srcTop, width: visibleWidth, height: visibleHeight }).png().toFile(croppedPath);
      compositeOps.push({ input: croppedPath, left: destLeft, top: destTop });
    }
  }

  let composite = sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } });
  if (compositeOps.length > 0) composite = composite.composite(compositeOps);
  await composite.png().toFile(backgroundPngPath);
  backgroundLayers.forEach(l => { try { fs.unlinkSync(l.path); } catch (e) { /* déjà supprimé */ } });
  compositeOps.forEach(op => { if (op.input.endsWith('_cropped.png')) { try { fs.unlinkSync(op.input); } catch (e) { /* déjà supprimé */ } } });

  return { backgroundPngPath, width: canvasWidth, height: canvasHeight, fields };
}

module.exports = { analyzePsd };
