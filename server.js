const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const db = require('./lib/db');
const auth = require('./lib/auth');
const mailer = require('./lib/mailer');
const { renderPng, pngToJpeg, pngToPdf } = require('./lib/render');
const { analyzePsd } = require('./lib/psd');
const { extractFields: extractDocxFields, renderDocx } = require('./lib/docx_render');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const UPLOADS_DIR = path.join(ROOT, 'data', 'uploads');
const RENDERS_DIR = path.join(ROOT, 'data', 'renders');
const WORK_DIR = path.join(ROOT, 'data', 'work');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(RENDERS_DIR, { recursive: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 40 * 1024 * 1024) { req.destroy(); reject(new Error('Payload trop volumineux (max 40 Mo)')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function id() { return crypto.randomUUID(); }

// Renvoie l'utilisateur courant ou répond 401 lui-même si non authentifié.
function requireAuth(req, res) {
  const user = auth.getUserFromRequest(req);
  if (!user) { sendJson(res, 401, { error: 'Authentification requise' }); return null; }
  return user;
}

// Authentification par clé API (Phase 4, intégrations tierces) : en-tête
// "Authorization: Bearer emp_xxx" au lieu du cookie de session.
function requireApiKey(req, res) {
  const header = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const apiKey = m ? m[1].trim() : null;
  const user = auth.getUserByApiKey(apiKey);
  if (!user) { sendJson(res, 401, { error: "Clé API invalide ou absente. Utilise l'en-tête 'Authorization: Bearer <clé>'." }); return null; }
  return user;
}

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------

async function signup(req, res) {
  const body = await readJsonBody(req);
  const { email, password } = body;
  if (!email || !password || password.length < 8) {
    return sendJson(res, 400, { error: 'E-mail requis et mot de passe d\'au moins 8 caractères.' });
  }
  let user;
  try {
    user = auth.createUser(email, password);
  } catch (e) {
    return sendJson(res, 409, { error: e.message });
  }
  const session = auth.createSession(user.id);
  auth.setSessionCookie(res, session.token);
  sendJson(res, 201, { id: user.id, email: user.email });
}

async function login(req, res) {
  const body = await readJsonBody(req);
  const user = auth.authenticate(body.email || '', body.password || '');
  if (!user) return sendJson(res, 401, { error: 'E-mail ou mot de passe incorrect.' });
  const session = auth.createSession(user.id);
  auth.setSessionCookie(res, session.token);
  sendJson(res, 200, { id: user.id, email: user.email });
}

function logout(req, res) {
  const cookies = auth.parseCookies(req);
  if (cookies.empreinte_session) auth.destroySession(cookies.empreinte_session);
  auth.clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}

function me(req, res) {
  const user = auth.getUserFromRequest(req);
  if (!user) return sendJson(res, 200, { user: null });
  const apiKey = auth.ensureApiKey(user);
  sendJson(res, 200, { user: { id: user.id, email: user.email, apiKey } });
}

function regenerateApiKeyHandler(req, res, user) {
  const apiKey = auth.regenerateApiKey(user.id);
  sendJson(res, 200, { apiKey });
}
function registerView(req, res, token) {
  const link = db.find('public_links', l => l.token === token);
  if (!link) return sendJson(res, 404, { error: 'Lien introuvable' });
  db.update('public_links', link.id, { views: (link.views || 0) + 1 });
  sendJson(res, 200, { ok: true });
}

// Personnalisation de la page publique (cahier des charges, section 4.4 / Phase 3) :
// logo, couleur principale, message d'accueil et message de remerciement.
async function saveBranding(req, res, templateId, user) {
  const template = db.find('templates', t => t.id === templateId);
  if (!template) return sendJson(res, 404, { error: 'Modèle introuvable' });
  if (template.ownerId !== user.id) return sendJson(res, 403, { error: 'Accès refusé' });
  const body = await readJsonBody(req);
  const branding = {
    primaryColor: body.primaryColor || '#1B2340',
    welcomeMessage: (body.welcomeMessage || '').slice(0, 300),
    thankYouMessage: (body.thankYouMessage || '').slice(0, 300),
    logoDataUrl: body.logoDataUrl || null
  };
  const updated = db.update('templates', templateId, { branding });
  sendJson(res, 200, { branding: updated.branding });
}

// Intégrations tierces (Phase 4) : URL de webhook notifiée après chaque génération.
async function saveIntegrations(req, res, templateId, user) {
  const template = db.find('templates', t => t.id === templateId);
  if (!template) return sendJson(res, 404, { error: 'Modèle introuvable' });
  if (template.ownerId !== user.id) return sendJson(res, 403, { error: 'Accès refusé' });
  const body = await readJsonBody(req);
  let webhookUrl = (body.webhookUrl || '').trim();
  if (webhookUrl) {
    try { new URL(webhookUrl); } catch (e) { return sendJson(res, 400, { error: 'URL de webhook invalide.' }); }
  }
  const patch = { webhookUrl: webhookUrl || null };
  if (typeof body.docxPreviewEnabled === 'boolean') patch.docxPreviewEnabled = body.docxPreviewEnabled;
  const updated = db.update('templates', templateId, patch);
  sendJson(res, 200, { webhookUrl: updated.webhookUrl, docxPreviewEnabled: !!updated.docxPreviewEnabled });
}

// Aperçu en direct pour un modèle Word (facultatif, coûteux : déclenche une vraie
// conversion LibreOffice à chaque appel). Version authentifiée pour l'administrateur
// pendant l'édition des champs, avec ses propres valeurs d'exemple.
async function previewDocxAdmin(req, res, templateId, user) {
  const template = db.find('templates', t => t.id === templateId);
  if (!template) return sendJson(res, 404, { error: 'Modèle introuvable' });
  if (template.ownerId !== user.id) return sendJson(res, 403, { error: 'Accès refusé' });
  if (template.type !== 'docx') return sendJson(res, 400, { error: 'Aperçu disponible uniquement pour les modèles Word.' });
  const body = await readJsonBody(req);
  const workDir = path.join(WORK_DIR, 'preview-' + id());
  try {
    const { pngBuffer } = renderDocx(path.join(UPLOADS_DIR, template.filename), body.values || {}, workDir);
    sendJson(res, 200, { previewDataUri: 'data:image/png;base64,' + pngBuffer.toString('base64') });
  } catch (e) {
    sendJson(res, 500, { error: "Impossible de générer l'aperçu : " + e.message });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Génération via l'API publique v1 (Phase 4) : permet à un système tiers de générer
// un document sans passer par le formulaire public, en fournissant les valeurs par
// NOM de champ (plus pratique pour un appelant externe qui ne connaît pas les id
// internes). Renvoie directement les URLs de téléchargement.
async function generateViaApi(req, res, templateId, user) {
  const template = db.find('templates', t => t.id === templateId);
  if (!template) return sendJson(res, 404, { error: 'Modèle introuvable' });
  if (template.ownerId !== user.id) return sendJson(res, 403, { error: 'Accès refusé' });
  const body = await readJsonBody(req);
  const fields = db.filter('template_fields', f => f.templateId === templateId);

  // body.values est attendu par NOM de champ : { "Nom": "Awa Koffi", ... }
  const valuesByName = body.values || {};
  const valuesById = {};
  fields.forEach(f => { if (valuesByName[f.name] !== undefined) valuesById[f.id] = valuesByName[f.name]; });

  const submissionId = id();
  const baseUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  const verifyUrl = `${baseUrl}/verify/${submissionId}`;
  const render = await buildRender(templateId, fields, valuesById, { verifyUrl });

  const displayValues = {};
  fields.forEach(f => {
    displayValues[f.name] = (f.type === 'image') ? '[photo]' : (f.type === 'qrcode') ? '[qr]' : (valuesByName[f.name] || f.sample || '');
  });
  const submission = {
    id: submissionId, linkId: null, templateId, renderId: render.id,
    values: displayValues, createdAt: new Date().toISOString(), valid: true, source: 'api'
  };
  db.insert('submissions', submission);

  const downloadUrls = {
    png: `${baseUrl}/api/renders/${render.id}.png`,
    jpeg: `${baseUrl}/api/renders/${render.id}.jpeg`,
    pdf: `${baseUrl}/api/renders/${render.id}.pdf`
  };
  sendJson(res, 201, { submissionId, renderId: render.id, verifyUrl, downloadUrls });
}

function csvEscape(value) {
  const s = String(value === undefined || value === null ? '' : value);
  if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function exportStatsCsv(req, res, templateId, user) {
  const template = db.find('templates', t => t.id === templateId);
  if (!template) return sendJson(res, 404, { error: 'Modèle introuvable' });
  if (template.ownerId !== user.id) return sendJson(res, 403, { error: 'Accès refusé' });
  const fields = db.filter('template_fields', f => f.templateId === templateId);
  const submissions = db.filter('submissions', s => s.templateId === templateId);

  const headers = ['Date', ...fields.map(f => f.name)];
  const rows = submissions.map(s => [
    new Date(s.createdAt).toLocaleString('fr-FR'),
    ...fields.map(f => s.values[f.name] || '')
  ]);
  const csv = [headers, ...rows].map(r => r.map(csvEscape).join(';')).join('\r\n');
  // BOM UTF-8 pour un affichage correct des accents dans Excel.
  send(res, 200, '\uFEFF' + csv, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="statistiques-${templateId}.csv"`
  });
}

function extFromMime(mime) {
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('png')) return '.png';
  return '.png';
}
function dataUriMeta(dataUri) {
  const m = /^data:(.+);base64,(.*)$/.exec(dataUri || '');
  if (!m) return null;
  return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

async function createTemplate(req, res, user) {
  const body = await readJsonBody(req);
  const { name, imageBase64 } = body;
  if (!imageBase64) return sendJson(res, 400, { error: 'imageBase64 requis' });
  const parsed = dataUriMeta(imageBase64);
  if (!parsed) return sendJson(res, 400, { error: "Format d'image invalide" });

  const templateId = id();
  const ext = extFromMime(parsed.mime);
  const filename = templateId + ext;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), parsed.buffer);

  const meta = await sharp(parsed.buffer).metadata();
  const template = {
    id: templateId,
    ownerId: user.id,
    name: name || 'Modèle sans titre',
    type: 'image',
    sourceType: 'upload',
    filename,
    width: meta.width,
    height: meta.height,
    createdAt: new Date().toISOString()
  };
  db.insert('templates', template);
  sendJson(res, 201, template);
}

// Import PSD : le fichier est analysé (calques nommés -> champs pré-positionnés),
// puis converti en un modèle "image" classique + ses champs, pour réutiliser tel
// quel tout le reste du pipeline (rendu, publication, export, stats).
async function createTemplateFromPsd(req, res, user) {
  const body = await readJsonBody(req);
  const { name, psdBase64 } = body;
  if (!psdBase64) return sendJson(res, 400, { error: 'psdBase64 requis' });
  const parsed = dataUriMeta(psdBase64);
  if (!parsed) return sendJson(res, 400, { error: 'Format PSD invalide' });

  const templateId = id();
  const workDir = path.join(WORK_DIR, 'psd-' + templateId);
  const psdPath = path.join(workDir, 'source.psd');
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(psdPath, parsed.buffer);

  let analysis;
  try {
    analysis = await analyzePsd(psdPath, workDir);
  } catch (e) {
    return sendJson(res, 400, { error: "Impossible d'analyser ce fichier PSD : " + e.message });
  }

  const filename = templateId + '.png';
  fs.copyFileSync(analysis.backgroundPngPath, path.join(UPLOADS_DIR, filename));
  fs.rmSync(workDir, { recursive: true, force: true });

  const template = {
    id: templateId,
    ownerId: user.id,
    name: name || 'Modèle sans titre',
    type: 'image',
    sourceType: 'psd',
    filename,
    width: analysis.width,
    height: analysis.height,
    createdAt: new Date().toISOString()
  };
  db.insert('templates', template);

  const fields = analysis.fields.map(f => ({ id: id(), templateId, ...f }));
  fields.forEach(f => db.insert('template_fields', f));

  sendJson(res, 201, { ...template, fields, detectedFieldsCount: fields.length });
}

// Import DOCX : les balises {{champ}} du document sont détectées et deviennent
// directement des champs de formulaire (pas de positionnement x/y : la mise en
// page reste celle du document Word).
async function createTemplateFromDocx(req, res, user) {
  const body = await readJsonBody(req);
  const { name, docxBase64 } = body;
  if (!docxBase64) return sendJson(res, 400, { error: 'docxBase64 requis' });
  const parsed = dataUriMeta(docxBase64);
  if (!parsed) return sendJson(res, 400, { error: 'Format DOCX invalide' });

  const templateId = id();
  const filename = templateId + '.docx';
  const filePath = path.join(UPLOADS_DIR, filename);
  fs.writeFileSync(filePath, parsed.buffer);

  let fieldNames;
  try {
    fieldNames = extractDocxFields(filePath);
  } catch (e) {
    return sendJson(res, 400, { error: "Impossible d'analyser ce fichier DOCX : " + e.message });
  }
  if (fieldNames.length === 0) {
    return sendJson(res, 400, { error: "Aucun champ {{champ}} détecté dans ce document. Ajoute des balises comme {{Nom}} dans le fichier Word puis réimporte-le." });
  }

  const template = {
    id: templateId,
    ownerId: user.id,
    name: name || 'Modèle sans titre',
    type: 'docx',
    sourceType: 'docx',
    filename,
    width: null,
    height: null,
    createdAt: new Date().toISOString()
  };
  db.insert('templates', template);

  const fields = fieldNames.map((fname, i) => ({
    id: id(), templateId, name: fname, type: 'text', order: i, sample: ''
  }));
  fields.forEach(f => db.insert('template_fields', f));

  sendJson(res, 201, { ...template, fields });
}

function listTemplates(req, res, user) {
  const templates = db.filter('templates', t => t.ownerId === user.id).map(t => {
    const fields = db.filter('template_fields', f => f.templateId === t.id);
    const links = db.filter('public_links', l => l.templateId === t.id);
    return { ...t, fieldsCount: fields.length, linksCount: links.length };
  });
  sendJson(res, 200, templates);
}

function getTemplate(req, res, templateId, user) {
  const template = db.find('templates', t => t.id === templateId);
  if (!template) return sendJson(res, 404, { error: 'Modèle introuvable' });
  if (template.ownerId !== user.id) return sendJson(res, 403, { error: 'Accès refusé' });
  const fields = db.filter('template_fields', f => f.templateId === templateId);
  const links = db.filter('public_links', l => l.templateId === templateId);
  sendJson(res, 200, { ...template, imageUrl: `/uploads/${template.filename}`, fields, links });
}

// Suppression complète d'un modèle : le fichier importé, tous les champs, liens,
// réponses et documents générés associés sont effacés du serveur (aucune trace
// ne subsiste, contrairement à une simple désactivation).
function deleteTemplate(req, res, templateId, user) {
  const template = db.find('templates', t => t.id === templateId);
  if (!template) return sendJson(res, 404, { error: 'Modèle introuvable' });
  if (template.ownerId !== user.id) return sendJson(res, 403, { error: 'Accès refusé' });

  const links = db.filter('public_links', l => l.templateId === templateId);
  const linkIds = links.map(l => l.id);
  const submissions = db.filter('submissions', s => s.templateId === templateId);

  // Fichiers de rendus générés (PNG + éventuel PDF pour les modèles DOCX).
  submissions.forEach(s => {
    ['.png', '.pdf'].forEach(ext => {
      const p = path.join(RENDERS_DIR, s.renderId + ext);
      try { fs.unlinkSync(p); } catch (e) { /* déjà absent */ }
    });
  });

  // Fichier du modèle importé lui-même (image, PSD converti, ou .docx).
  try { fs.unlinkSync(path.join(UPLOADS_DIR, template.filename)); } catch (e) { /* déjà absent */ }

  db.replaceWhere('template_fields', f => f.templateId === templateId, []);
  db.replaceWhere('public_links', l => l.templateId === templateId, []);
  db.replaceWhere('submissions', s => s.templateId === templateId, []);
  db.replaceWhere('renders', r => r.templateId === templateId, []);
  db.replaceWhere('templates', t => t.id === templateId, []);

  sendJson(res, 200, { ok: true });
}

async function saveFields(req, res, templateId, user) {
  const template = db.find('templates', t => t.id === templateId);
  if (!template) return sendJson(res, 404, { error: 'Modèle introuvable' });
  if (template.ownerId !== user.id) return sendJson(res, 403, { error: 'Accès refusé' });
  const body = await readJsonBody(req);
  const fields = (body.fields || []).map(f => ({
    id: f.id || id(),
    templateId,
    name: f.name,
    type: f.type,
    x: f.x, y: f.y, w: f.w, h: f.h,
    fontSize: f.fontSize, color: f.color, align: f.align,
    sample: f.sample || ''
  }));
  db.replaceWhere('template_fields', f => f.templateId === templateId, fields);
  sendJson(res, 200, { fields });
}

function publishLink(req, res, templateId, user) {
  const template = db.find('templates', t => t.id === templateId);
  if (!template) return sendJson(res, 404, { error: 'Modèle introuvable' });
  if (template.ownerId !== user.id) return sendJson(res, 403, { error: 'Accès refusé' });
  const link = { id: id(), templateId, token: crypto.randomBytes(6).toString('hex'), createdAt: new Date().toISOString() };
  db.insert('public_links', link);
  sendJson(res, 201, link);
}

function getPublicForm(req, res, token) {
  const link = db.find('public_links', l => l.token === token);
  if (!link) return sendJson(res, 404, { error: 'Lien introuvable ou expiré' });
  const template = db.find('templates', t => t.id === link.templateId);
  const fields = db.filter('template_fields', f => f.templateId === link.templateId);
  sendJson(res, 200, {
    linkId: link.id,
    template: {
      id: template.id, name: template.name, type: template.type,
      width: template.width, height: template.height,
      imageUrl: template.type === 'image' ? `/uploads/${template.filename}` : null,
      branding: template.branding || null,
      mailEnabled: mailer.isConfigured(),
      docxPreviewEnabled: !!template.docxPreviewEnabled
    },
    fields
  });
}

async function buildRender(templateId, fields, values, options = {}) {
  const template = db.find('templates', t => t.id === templateId);
  const templatePath = path.join(UPLOADS_DIR, template.filename);
  const renderId = id();

  if (template.type === 'docx') {
    // values arrive keyed by field id (id venant du formulaire) -> il faut les
    // reclasser par NOM de champ pour le remplissage des balises {{champ}}.
    const valuesByName = {};
    fields.forEach(f => { valuesByName[f.name] = values[f.id] || ''; });
    const workDir = path.join(WORK_DIR, 'render-' + renderId);
    const { pdfBuffer, pngBuffer } = renderDocx(templatePath, valuesByName, workDir);
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.writeFileSync(path.join(RENDERS_DIR, renderId + '.pdf'), pdfBuffer);
    fs.writeFileSync(path.join(RENDERS_DIR, renderId + '.png'), pngBuffer);
  } else {
    // Les champs "qrcode" encodent tous l'URL de vérification de cette soumission
    // (utile pour un contrôle d'accès à l'entrée d'un événement, par exemple).
    const qrValues = {};
    if (options.verifyUrl) {
      fields.filter(f => f.type === 'qrcode').forEach(f => { qrValues[f.id] = options.verifyUrl; });
    }
    const pngBuffer = await renderPng(templatePath, fields, values, { qrValues });
    fs.writeFileSync(path.join(RENDERS_DIR, renderId + '.png'), pngBuffer);
  }

  const render = { id: renderId, templateId, createdAt: new Date().toISOString() };
  db.insert('renders', render);
  return render;
}

async function previewPublic(req, res, token) {
  const link = db.find('public_links', l => l.token === token);
  if (!link) return sendJson(res, 404, { error: 'Lien introuvable' });
  const template = db.find('templates', t => t.id === link.templateId);
  const fields = db.filter('template_fields', f => f.templateId === link.templateId);
  const body = await readJsonBody(req);

  if (template.type === 'docx') {
    if (!template.docxPreviewEnabled) return sendJson(res, 400, { error: "Aperçu non activé pour ce modèle — génère le document pour le voir." });
    const valuesByName = {};
    fields.forEach(f => { valuesByName[f.name] = (body.values || {})[f.id] || ''; });
    const workDir = path.join(WORK_DIR, 'preview-' + id());
    try {
      const { pngBuffer } = renderDocx(path.join(UPLOADS_DIR, template.filename), valuesByName, workDir);
      return sendJson(res, 200, { previewDataUri: 'data:image/png;base64,' + pngBuffer.toString('base64') });
    } catch (e) {
      return sendJson(res, 500, { error: "Impossible de générer l'aperçu : " + e.message });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  const pngBuffer = await renderPng(path.join(UPLOADS_DIR, template.filename), fields, body.values || {});
  sendJson(res, 200, { previewDataUri: 'data:image/png;base64,' + pngBuffer.toString('base64') });
}

async function submitPublic(req, res, token) {
  const link = db.find('public_links', l => l.token === token);
  if (!link) return sendJson(res, 404, { error: 'Lien introuvable ou expiré' });
  const template = db.find('templates', t => t.id === link.templateId);
  const body = await readJsonBody(req);
  const fields = db.filter('template_fields', f => f.templateId === link.templateId);

  const submissionId = id();
  const baseUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  const verifyUrl = `${baseUrl}/verify/${submissionId}`;

  const render = await buildRender(link.templateId, fields, body.values || {}, { verifyUrl });

  const displayValues = {};
  for (const f of fields) {
    const v = (body.values || {})[f.id];
    displayValues[f.name] = (f.type === 'image') ? '[photo]' : (f.type === 'qrcode') ? '[qr]' : (v || f.sample || '');
  }
  const submission = {
    id: submissionId, linkId: link.id, templateId: link.templateId,
    renderId: render.id, values: displayValues, createdAt: new Date().toISOString(), valid: true
  };
  db.insert('submissions', submission);

  const downloadUrls = {
    png: `/api/renders/${render.id}.png`,
    jpeg: `/api/renders/${render.id}.jpeg`,
    pdf: `/api/renders/${render.id}.pdf`
  };

  // Envoi par e-mail (Phase 4) : facultatif, uniquement si le SMTP est configuré
  // (voir lib/mailer.js) et qu'une adresse a été renseignée dans le formulaire public.
  // N'échoue jamais la requête : une panne SMTP ne doit pas empêcher l'utilisateur
  // de récupérer son document via les liens de téléchargement classiques.
  let emailStatus = null;
  if (body.email && mailer.isConfigured()) {
    emailStatus = await sendDocumentByEmail({ to: body.email, template, renderId: render.id, downloadUrls, baseUrl });
  } else if (body.email) {
    emailStatus = { sent: false, error: 'Envoi par e-mail non configuré côté serveur (variables SMTP_* absentes).' };
  }

  // Notification webhook (Phase 4) : best-effort, ne bloque jamais la réponse HTTP
  // ni ne peut la faire échouer.
  if (template.webhookUrl) {
    notifyWebhook(template.webhookUrl, {
      event: 'submission.created',
      templateId: template.id, templateName: template.name,
      submissionId, values: displayValues,
      downloadUrls: Object.fromEntries(Object.entries(downloadUrls).map(([k, v]) => [k, baseUrl + v])),
      verifyUrl, createdAt: submission.createdAt
    });
  }

  sendJson(res, 201, { submissionId: submission.id, renderId: render.id, downloadUrls, verifyUrl, emailStatus });
}

async function sendDocumentByEmail({ to, template, renderId, downloadUrls, baseUrl }) {
  const pdfPath = path.join(RENDERS_DIR, renderId + '.pdf');
  const pngPath = path.join(RENDERS_DIR, renderId + '.png');
  let attachment;
  if (fs.existsSync(pdfPath)) {
    attachment = { buffer: fs.readFileSync(pdfPath), mime: 'application/pdf', filename: 'document.pdf' };
  } else {
    const pngBuffer = fs.readFileSync(pngPath);
    attachment = { buffer: await pngToPdf(pngBuffer), mime: 'application/pdf', filename: 'document.pdf' };
  }
  return mailer.sendMail({
    to,
    subject: `Ton document — ${template.name}`,
    text: `Bonjour,\n\nVoici ton document généré via "${template.name}", en pièce jointe.\n` +
      `Tu peux aussi le télécharger directement : ${baseUrl}${downloadUrls.pdf}\n\n— Empreinte`,
    attachment
  });
}

// Webhook : notifie une URL tierce après chaque génération (intégrations externes,
// Phase 4). Requête POST JSON best-effort via le module http/https natif — aucune
// dépendance ajoutée, et un échec ne remonte jamais au flux principal.
function notifyWebhook(webhookUrl, payload) {
  let target;
  try { target = new URL(webhookUrl); } catch (e) { return; }
  const lib = target.protocol === 'https:' ? require('https') : require('http');
  const data = Buffer.from(JSON.stringify(payload));
  const req = lib.request(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'User-Agent': 'Empreinte-Webhook/1.0' },
    timeout: 8000
  });
  req.on('error', () => { /* best-effort : on ignore les échecs de webhook */ });
  req.on('timeout', () => req.destroy());
  req.end(data);
}

function verifySubmission(req, res, submissionId) {
  const submission = db.find('submissions', s => s.id === submissionId);
  if (!submission || submission.valid === false) {
    return send(res, 404,
      `<!DOCTYPE html><html lang="fr"><meta charset="UTF-8"><body style="font-family:sans-serif;text-align:center;padding:60px 20px;background:#F7F3EC;">
       <h1 style="color:#A6423B;">Document introuvable ou invalidé</h1></body></html>`,
      { 'Content-Type': 'text/html; charset=utf-8' });
  }
  const template = db.find('templates', t => t.id === submission.templateId);
  const rows = Object.entries(submission.values)
    .filter(([, v]) => v !== '[qr]')
    .map(([k, v]) => `<tr><td style="padding:6px 14px;color:#6B7280;">${k}</td><td style="padding:6px 14px;font-weight:600;">${v}</td></tr>`)
    .join('');
  send(res, 200, `<!DOCTYPE html><html lang="fr"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <body style="font-family:sans-serif;background:#F7F3EC;padding:50px 20px;text-align:center;">
      <div style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #DDD6C9;padding:30px;">
        <div style="font-size:40px;">✅</div>
        <h1 style="font-size:18px;color:#1B2340;">Document valide</h1>
        <p style="color:#6B7280;font-size:13px;">${template ? template.name : ''}</p>
        <table style="margin:16px auto;text-align:left;">${rows}</table>
        <p style="color:#8A93A6;font-size:11.5px;">Généré le ${new Date(submission.createdAt).toLocaleString('fr-FR')}</p>
      </div>
    </body></html>`, { 'Content-Type': 'text/html; charset=utf-8' });
}

async function serveRender(req, res, renderId, format) {
  const render = db.find('renders', r => r.id === renderId);
  if (!render) return sendJson(res, 404, { error: 'Rendu introuvable' });
  const pngPath = path.join(RENDERS_DIR, renderId + '.png');
  const storedPdfPath = path.join(RENDERS_DIR, renderId + '.pdf');
  if (!fs.existsSync(pngPath)) return sendJson(res, 404, { error: 'Fichier introuvable' });
  const pngBuffer = fs.readFileSync(pngPath);

  if (format === 'png') return send(res, 200, pngBuffer, { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="document.png"' });
  if (format === 'jpeg' || format === 'jpg') {
    const jpeg = await pngToJpeg(pngBuffer);
    return send(res, 200, jpeg, { 'Content-Type': 'image/jpeg', 'Content-Disposition': 'attachment; filename="document.jpg"' });
  }
  if (format === 'pdf') {
    // Un modèle DOCX a déjà un PDF fidèle (généré par LibreOffice) : on le sert tel
    // quel plutôt que d'en resynthétiser un à partir du PNG.
    const pdf = fs.existsSync(storedPdfPath) ? fs.readFileSync(storedPdfPath) : await pngToPdf(pngBuffer);
    return send(res, 200, pdf, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="document.pdf"' });
  }
  sendJson(res, 400, { error: 'Format non supporté' });
}

function computeStats(req, res, templateId, user) {
  const template = db.find('templates', t => t.id === templateId);
  if (!template) return sendJson(res, 404, { error: 'Modèle introuvable' });
  if (template.ownerId !== user.id) return sendJson(res, 403, { error: 'Accès refusé' });
  const submissions = db.filter('submissions', s => s.templateId === templateId);
  const byDay = {};
  submissions.forEach(s => {
    const day = s.createdAt.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  });
  const links = db.filter('public_links', l => l.templateId === templateId).map(l => ({
    ...l, submissions: submissions.filter(s => s.linkId === l.id).length
  }));
  const totalViews = links.reduce((sum, l) => sum + (l.views || 0), 0);
  const completionRate = totalViews > 0 ? Math.round((submissions.length / totalViews) * 100) : null;
  sendJson(res, 200, {
    total: submissions.length,
    totalViews,
    completionRate,
    byDay,
    links,
    recent: submissions.slice(-10).reverse()
  });
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

function serveStatic(req, res, filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return sendJson(res, 404, { error: 'Not found' });
  const ext = path.extname(filePath);
  // Sans cet en-tête, les navigateurs gardent en cache admin.html/form.html et
  // n'affichent pas tout de suite une mise à jour de l'application après un
  // redéploiement — d'où l'impression qu'un changement "n'a pas pris".
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  if (ext === '.html') headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
  send(res, 200, fs.readFileSync(filePath), headers);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const m = req.method;

    if (m === 'OPTIONS') return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });

    // ---- Auth ----
    if (p === '/api/auth/signup' && m === 'POST') return await signup(req, res);
    if (p === '/api/auth/login' && m === 'POST') return await login(req, res);
    if (p === '/api/auth/logout' && m === 'POST') return logout(req, res);
    if (p === '/api/auth/me' && m === 'GET') return me(req, res);

    // ---- API (protégée : nécessite une session) ----
    if (p === '/api/templates' && m === 'POST') { const u = requireAuth(req, res); if (!u) return; return await createTemplate(req, res, u); }
    if (p === '/api/templates/psd' && m === 'POST') { const u = requireAuth(req, res); if (!u) return; return await createTemplateFromPsd(req, res, u); }
    if (p === '/api/templates/docx' && m === 'POST') { const u = requireAuth(req, res); if (!u) return; return await createTemplateFromDocx(req, res, u); }
    if (p === '/api/templates' && m === 'GET') { const u = requireAuth(req, res); if (!u) return; return listTemplates(req, res, u); }

    let match;
    if ((match = /^\/api\/templates\/([^/]+)$/.exec(p)) && m === 'GET') { const u = requireAuth(req, res); if (!u) return; return getTemplate(req, res, match[1], u); }
    if ((match = /^\/api\/templates\/([^/]+)$/.exec(p)) && m === 'DELETE') { const u = requireAuth(req, res); if (!u) return; return deleteTemplate(req, res, match[1], u); }
    if ((match = /^\/api\/templates\/([^/]+)\/fields$/.exec(p)) && m === 'PUT') { const u = requireAuth(req, res); if (!u) return; return await saveFields(req, res, match[1], u); }
    if ((match = /^\/api\/templates\/([^/]+)\/publish$/.exec(p)) && m === 'POST') { const u = requireAuth(req, res); if (!u) return; return publishLink(req, res, match[1], u); }
    if ((match = /^\/api\/templates\/([^/]+)\/branding$/.exec(p)) && m === 'PUT') { const u = requireAuth(req, res); if (!u) return; return await saveBranding(req, res, match[1], u); }
    if ((match = /^\/api\/templates\/([^/]+)\/integrations$/.exec(p)) && m === 'PUT') { const u = requireAuth(req, res); if (!u) return; return await saveIntegrations(req, res, match[1], u); }
    if ((match = /^\/api\/templates\/([^/]+)\/preview-docx$/.exec(p)) && m === 'POST') { const u = requireAuth(req, res); if (!u) return; return await previewDocxAdmin(req, res, match[1], u); }
    if ((match = /^\/api\/templates\/([^/]+)\/stats$/.exec(p)) && m === 'GET') { const u = requireAuth(req, res); if (!u) return; return computeStats(req, res, match[1], u); }
    if ((match = /^\/api\/templates\/([^/]+)\/stats\/export\.csv$/.exec(p)) && m === 'GET') { const u = requireAuth(req, res); if (!u) return; return exportStatsCsv(req, res, match[1], u); }
    if (p === '/api/auth/api-key/regenerate' && m === 'POST') { const u = requireAuth(req, res); if (!u) return; return regenerateApiKeyHandler(req, res, u); }

    // ---- API publique v1 (intégrations tierces, authentifiée par clé API — Phase 4) ----
    if (p === '/api/v1/templates' && m === 'GET') { const u = requireApiKey(req, res); if (!u) return; return listTemplates(req, res, u); }
    if ((match = /^\/api\/v1\/templates\/([^/]+)\/generate$/.exec(p)) && m === 'POST') { const u = requireApiKey(req, res); if (!u) return; return await generateViaApi(req, res, match[1], u); }

    // ---- API publique (aucune authentification : accessible aux utilisateurs finaux) ----
    if ((match = /^\/api\/public\/([^/]+)$/.exec(p)) && m === 'GET') return getPublicForm(req, res, match[1]);
    if ((match = /^\/api\/public\/([^/]+)\/view$/.exec(p)) && m === 'POST') return registerView(req, res, match[1]);
    if ((match = /^\/api\/public\/([^/]+)\/preview$/.exec(p)) && m === 'POST') return await previewPublic(req, res, match[1]);
    if ((match = /^\/api\/public\/([^/]+)\/submit$/.exec(p)) && m === 'POST') return await submitPublic(req, res, match[1]);

    if ((match = /^\/api\/renders\/([^/.]+)\.(png|jpe?g|pdf)$/.exec(p)) && m === 'GET') return await serveRender(req, res, match[1], match[2]);
    if ((match = /^\/verify\/([^/]+)$/.exec(p)) && m === 'GET') return verifySubmission(req, res, match[1]);

    // ---- Uploaded template images ----
    if ((match = /^\/uploads\/([^/]+)$/.exec(p)) && m === 'GET') return serveStatic(req, res, path.join(UPLOADS_DIR, match[1]));

    // ---- Static frontend ----
    if (p === '/' || p === '/admin') return serveStatic(req, res, path.join(ROOT, 'public', 'admin.html'));
    if (p === '/form') return serveStatic(req, res, path.join(ROOT, 'public', 'form.html'));
    if (p.startsWith('/public-assets/')) return serveStatic(req, res, path.join(ROOT, 'public', p.replace('/public-assets/', '')));

    sendJson(res, 404, { error: 'Route introuvable' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Empreinte MVP démarré : http://localhost:${PORT}/admin`);
  // Diagnostic utile après un déploiement : si ce nombre de comptes retombe à 0
  // à chaque redémarrage alors que tu en as déjà créé, c'est que le dossier
  // data/ n'est pas persistant (volume manquant ou mal configuré sur l'hébergeur).
  const userCount = db.all('users').length;
  const templateCount = db.all('templates').length;
  console.log(`Données chargées depuis data/db.json : ${userCount} compte(s), ${templateCount} modèle(s).`);
  if (userCount === 0) {
    console.log("Aucun compte trouvé — normal au tout premier démarrage. Si tu en avais déjà créé un, vérifie que le dossier data/ est bien sur un volume persistant.");
  }
});
