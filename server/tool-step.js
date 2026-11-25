'use strict';

const NUMBER_FIELDS = Object.freeze(['count', 'bytes', 'totalSize']);
const BOOLEAN_FIELDS = Object.freeze(['truncated', 'written', 'pending', 'deduped']);
const STRING_FIELDS = Object.freeze(['status', 'code', 'decision']);

function sanitizeToolEvidence(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const evidence = {};

  for (const field of NUMBER_FIELDS) {
    const value = raw[field];
    if (Number.isFinite(value) && value >= 0) {
      evidence[field] = Math.floor(value);
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof raw[field] === 'boolean') evidence[field] = raw[field];
  }
  for (const field of STRING_FIELDS) {
    const value = raw[field];
    if (typeof value === 'string' && /^[a-z0-9_.:-]{1,40}$/i.test(value)) {
      evidence[field] = value;
    }
  }
  if (!evidence.status && typeof raw.ok === 'boolean') {
    evidence.status = raw.ok ? 'success' : 'failed';
  }

  return Object.keys(evidence).length ? evidence : undefined;
}

module.exports = { sanitizeToolEvidence };
