'use strict';

// Fleet V5 contract records in Fleet memory. One stored memory value holds at
// most 32 KB (StateStore MAX_MEMORY_VALUE_BYTES), and a real lead contract
// with its review, worker reports and events is larger. The record keeps its
// identity and control fields in one value, the head; its review
// (review.before) is always stored apart, and then its largest other fields
// until the head fits.
//
// A part is the JSON text of one field, cut into pieces that each fit one
// value, stored in PART_NAMESPACE under
// <record key>/<field>/<head revision written>/<sha256>/<n>. The head names
// each part {sha256, pieces, at}. Pieces are written before the head; a part
// whose content is unchanged keeps the pieces it already has. Once the head is
// saved, the pieces only the previous head named are released (overwritten
// with a small marker: the store has no single-key delete). Because keys carry
// the head revision they were written for, a released key is never named by a
// later head. A reader that finds a released piece read a head that has since
// been replaced, and reads the head again. A reader always gets the part the
// head names, so open point ids stay those of the submitted review.

const crypto = require('node:crypto');

const PART_NAMESPACE = 'fleet.v5.contract-parts';
const PART_SCHEMA = 'ai.toolsenabled/fleet-v5-contract-part/v1';
const VALUE_LIMIT = 32 * 1024;
// A piece's text budget, leaving room for its envelope within VALUE_LIMIT.
const PIECE_BUDGET = 30 * 1024;
const ALWAYS = ['review.before'];
// Fields the head always keeps: what identifies the record and drives its state.
const INLINE = new Set(['schema', 'contractId', 'idempotencyKey', 'inputDigest', 'revision', 'status', 'operation', 'execution',
  'createdAt', 'updatedAt', 'parts', 'review']);
// review's other fields may go apart too; review.before always does.
const REVIEW_FIELDS = ['events', 'after', 'determinacy'];

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
function error(code, message) { throw Object.assign(new Error(message), { code }); }

function getPath(value, path) { return path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), value); }
function setPath(value, path, next) {
  const keys = path.split('.');
  const parent = keys.slice(0, -1).reduce((node, key) => (node[key] && typeof node[key] === 'object' ? node[key] : (node[key] = {})), value);
  parent[keys.at(-1)] = next;
}
function deletePath(value, path) {
  const keys = path.split('.');
  const parent = keys.length === 1 ? value : getPath(value, keys.slice(0, -1).join('.'));
  if (parent && typeof parent === 'object') delete parent[keys.at(-1)];
}

// Cut text into pieces whose JSON encoding fits PIECE_BUDGET, never between
// the two halves of a surrogate pair.
function pieces(text) {
  const out = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + PIECE_BUDGET);
    while (end - start > 1 && bytes(text.slice(start, end)) > PIECE_BUDGET) end = start + Math.max(1, Math.floor((end - start) * 0.9));
    const code = text.charCodeAt(end - 1);
    if (end < text.length && end - start > 1 && code >= 0xd800 && code <= 0xdbff) end -= 1;
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

const pieceKey = (recordKey, path, part, n) => `${recordKey}/${path}/${part.at}/${part.sha256}/${n}`;
const partKeys = (recordKey, parts) => Object.entries(parts && typeof parts === 'object' ? parts : {})
  .flatMap(([path, part]) => Array.from({ length: part.pieces }, (_, k) => pieceKey(recordKey, path, part, k + 1)));

/**
 * split(record, recordKey, {previous, revision}) -> {head, writes, release}.
 * previous is the head now stored (or null); revision is the head revision
 * this write creates. writes ({key, value}) go to PART_NAMESPACE before the
 * head; release lists the keys to release once the head is saved.
 */
function split(record, recordKey, { previous = null, revision = 1 } = {}) {
  const head = JSON.parse(JSON.stringify(record));
  delete head.parts;
  const before = previous && typeof previous.parts === 'object' && previous.parts ? previous.parts : {};
  const parts = {};
  const writes = [];
  const spill = path => {
    const value = getPath(head, path);
    if (value === undefined) return;
    const text = JSON.stringify(value);
    const digest = sha256(text);
    deletePath(head, path);
    if (before[path]?.sha256 === digest) { parts[path] = { ...before[path] }; return; }
    const cut = pieces(text);
    parts[path] = { sha256: digest, pieces: cut.length, at: revision };
    cut.forEach((piece, n) => writes.push({ key: pieceKey(recordKey, path, parts[path], n + 1),
      value: { schema: PART_SCHEMA, sha256: digest, piece: n + 1, of: cut.length, text: piece } }));
  };
  for (const path of ALWAYS) spill(path);
  const candidates = [...Object.keys(head).filter(key => !INLINE.has(key)), ...REVIEW_FIELDS.map(key => `review.${key}`)]
    .map(path => ({ path, size: getPath(head, path) === undefined ? 0 : bytes(getPath(head, path)) })).filter(row => row.size > 0)
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  for (const { path } of candidates) if (bytes({ ...head, parts }) > VALUE_LIMIT) spill(path);
  if (Object.keys(parts).length) head.parts = parts;
  const kept = new Set(partKeys(recordKey, parts));
  return { head, writes, release: partKeys(recordKey, before).filter(key => !kept.has(key)) };
}

/** The value a released piece is overwritten with. */
const RELEASED = Object.freeze({ schema: PART_SCHEMA, released: true });

/**
 * join(head, recordKey, readPiece) -> the whole record: each part the head
 * names, read with readPiece(key) -> stored piece value, checked against its
 * sha256. A head without parts (a record stored whole) is returned as it is.
 * A released piece is FLEET_V5_RECORD_PART_RELEASED (read the head again);
 * a missing or altered one FLEET_V5_RECORD_PART_MISSING.
 */
function join(head, recordKey, readPiece) {
  if (!head || typeof head !== 'object' || !head.parts || typeof head.parts !== 'object') return head;
  const record = JSON.parse(JSON.stringify(head));
  delete record.parts;
  for (const [path, part] of Object.entries(head.parts)) {
    let text = '';
    for (let n = 1; n <= part.pieces; n++) {
      const piece = readPiece(pieceKey(recordKey, path, part, n));
      if (piece?.released) error('FLEET_V5_RECORD_PART_RELEASED', `The stored ${path} of this contract record was replaced while it was read.`);
      if (!piece || piece.sha256 !== part.sha256 || piece.piece !== n || typeof piece.text !== 'string')
        error('FLEET_V5_RECORD_PART_MISSING', `The stored ${path} of this contract record is missing piece ${n} of ${part.pieces}.`);
      text += piece.text;
    }
    if (sha256(text) !== part.sha256) error('FLEET_V5_RECORD_PART_MISSING', `The stored ${path} of this contract record does not match its digest.`);
    setPath(record, path, JSON.parse(text));
  }
  return record;
}

module.exports = Object.freeze({ PART_NAMESPACE, PART_SCHEMA, VALUE_LIMIT, RELEASED, split, join, pieces });
