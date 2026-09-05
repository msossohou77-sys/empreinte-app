// Authentification minimale pour la gestion multi-utilisateurs (cahier des charges,
// section 7, Phase 3). Chaque administrateur a son propre compte ; ses modèles ne
// sont visibles que par lui (isolation par ownerId).
//
// Choix volontairement simple pour rester sans dépendance externe (pas de bcrypt/jsonwebtoken
// disponibles hors-ligne) : hachage par scrypt (natif à Node) + session opaque stockée
// côté serveur et transmise via cookie HttpOnly. À remplacer par de vrais JWT + un
// vrai magasin de sessions (Redis) en production, comme indiqué au cahier des charges.

const crypto = require('crypto');
const db = require('./db');

const SESSION_COOKIE = 'empreinte_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const attempt = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return attempt.length === stored.length && crypto.timingSafeEqual(attempt, stored);
}

function createUser(email, password) {
  const existing = db.find('users', u => u.email.toLowerCase() === email.toLowerCase());
  if (existing) throw new Error('Un compte existe déjà avec cet e-mail.');
  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(), email, salt, hash,
    apiKey: 'emp_' + crypto.randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString()
  };
  db.insert('users', user);
  return user;
}

function getUserByApiKey(apiKey) {
  if (!apiKey) return null;
  return db.find('users', u => u.apiKey === apiKey) || null;
}

// Les comptes créés avant l'ajout des clés API (Phase 4) n'en ont pas encore :
// on leur en attribue une à la volée plutôt que de forcer une migration.
function ensureApiKey(user) {
  if (user.apiKey) return user.apiKey;
  const apiKey = 'emp_' + crypto.randomBytes(24).toString('hex');
  db.update('users', user.id, { apiKey });
  user.apiKey = apiKey;
  return apiKey;
}

function regenerateApiKey(userId) {
  const apiKey = 'emp_' + crypto.randomBytes(24).toString('hex');
  db.update('users', userId, { apiKey });
  return apiKey;
}

function authenticate(email, password) {
  const user = db.find('users', u => u.email.toLowerCase() === email.toLowerCase());
  if (!user || !verifyPassword(password, user.salt, user.hash)) return null;
  return user;
}

function createSession(userId) {
  const session = {
    token: crypto.randomBytes(24).toString('hex'),
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  };
  db.insert('sessions', session);
  return session;
}

function destroySession(token) {
  const remaining = db.all('sessions').filter(s => s.token !== token);
  db.replaceWhere('sessions', () => true, remaining);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function getUserFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = db.find('sessions', s => s.token === token);
  if (!session || new Date(session.expiresAt) < new Date()) return null;
  return db.find('users', u => u.id === session.userId) || null;
}

function setSessionCookie(res, token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

module.exports = {
  createUser, authenticate, createSession, destroySession,
  getUserFromRequest, setSessionCookie, clearSessionCookie, parseCookies,
  getUserByApiKey, ensureApiKey, regenerateApiKey
};
