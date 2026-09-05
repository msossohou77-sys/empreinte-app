// Stockage très simple, basé sur un fichier JSON.
// Objectif : reproduire fidèlement les tables décrites dans le cahier des charges
// (templates, template_fields, public_links, submissions, renders) sans dépendre
// d'un serveur de base de données externe, pour que ce MVP tourne "out of the box".
// -> À remplacer par PostgreSQL en production (voir cahier des charges, section 5.7).

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

const EMPTY = {
  users: [],
  sessions: [],
  templates: [],
  template_fields: [],
  public_links: [],
  submissions: [],
  renders: []
};

function load() {
  if (!fs.existsSync(DB_PATH)) {
    save(structuredClone(EMPTY));
    return structuredClone(EMPTY);
  }
  const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  // Migration douce : un fichier db.json créé par une version antérieure peut ne
  // pas encore avoir toutes les tables (ex. "users"/"sessions" ajoutées en Phase 3).
  let changed = false;
  for (const key of Object.keys(EMPTY)) {
    if (!Array.isArray(data[key])) { data[key] = []; changed = true; }
  }
  if (changed) save(data);
  return data;
}

function save(data) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function insert(table, record) {
  const data = load();
  data[table].push(record);
  save(data);
  return record;
}

function all(table) {
  return load()[table];
}

function find(table, predicate) {
  return load()[table].find(predicate);
}

function filter(table, predicate) {
  return load()[table].filter(predicate);
}

function replaceWhere(table, predicate, newRecords) {
  const data = load();
  data[table] = data[table].filter(r => !predicate(r)).concat(newRecords);
  save(data);
}

function update(table, id, patch) {
  const data = load();
  const rec = data[table].find(r => r.id === id);
  if (!rec) return null;
  Object.assign(rec, patch);
  save(data);
  return rec;
}

module.exports = { insert, all, find, filter, replaceWhere, update };
