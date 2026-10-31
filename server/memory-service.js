/* global module */
/**
 * 记忆维护服务门面：审批执行器只能通过这里操作记忆。
 * 这里做参数白名单与结果摘要，不复制 memory.js 的生命周期/落盘逻辑。
 */
const memory = require('./memory');

const OPERATIONS = Object.freeze([
  'update',
  'merge',
  'supersede',
  'archive',
  'withdraw',
  'delete',
]);

const RISK = Object.freeze({
  update: 'medium',
  merge: 'medium',
  supersede: 'medium',
  archive: 'high',
  withdraw: 'high',
  delete: 'high',
});

const ALLOWED_TYPES = new Set(['identity', 'preference', 'fact', 'goal', 'relationship']);
const ID_MAX = 120;

function fail(error) {
  return { ok: false, error };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanId(value) {
  return typeof value === 'string' ? value.trim().slice(0, ID_MAX) : '';
}

function unknownKeys(value, allowed) {
  return Object.keys(value).filter(key => !allowed.has(key));
}

function validDate(value) {
  return value === null || value === '' || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function normalizeKeywords(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(
    value
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
  )].slice(0, 5);
}

function normalizeUpdate(raw) {
  const allowed = new Set([
    'id',
    'content',
    'type',
    'keywords',
    'confidence',
    'validFrom',
    'validTo',
    'condition',
  ]);
  if (unknownKeys(raw, allowed).length) return fail('unknown_field');
  const id = cleanId(raw.id);
  if (!id) return fail('missing_id');
  const value = { id };
  if (raw.content !== undefined) {
    if (typeof raw.content !== 'string' || !raw.content.trim() || raw.content.length > 100) {
      return fail('invalid_content');
    }
    value.content = raw.content.trim();
  }
  if (raw.type !== undefined) {
    if (!ALLOWED_TYPES.has(raw.type)) return fail('type_not_allowed');
    value.type = raw.type;
  }
  if (raw.keywords !== undefined) {
    const keywords = normalizeKeywords(raw.keywords);
    if (!keywords) return fail('invalid_keywords');
    value.keywords = keywords;
  }
  if (raw.confidence !== undefined) {
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return fail('invalid_confidence');
    }
    value.confidence = confidence;
  }
  if (raw.validFrom !== undefined) {
    if (!validDate(raw.validFrom)) return fail('invalid_valid_from');
    value.validFrom = raw.validFrom;
  }
  if (raw.validTo !== undefined) {
    if (!validDate(raw.validTo)) return fail('invalid_valid_to');
    value.validTo = raw.validTo;
  }
  if (raw.condition !== undefined) {
    if (typeof raw.condition !== 'string' || raw.condition.length > 80) {
      return fail('condition_too_long');
    }
    value.condition = raw.condition;
  }
  if (Object.keys(value).length === 1) return fail('no_changes');
  return { ok: true, value };
}

function normalizeMerge(raw) {
  const allowed = new Set(['targetId', 'sourceIds', 'content', 'keywords']);
  if (unknownKeys(raw, allowed).length) return fail('unknown_field');
  const targetId = cleanId(raw.targetId);
  if (!targetId) return fail('missing_target_id');
  if (!Array.isArray(raw.sourceIds) || !raw.sourceIds.length || raw.sourceIds.length > 20) {
    return fail('invalid_source_ids');
  }
  const sourceIds = [...new Set(raw.sourceIds.map(cleanId).filter(Boolean))].filter(
    id => id !== targetId
  );
  if (!sourceIds.length) return fail('invalid_source_ids');
  const value = { targetId, sourceIds };
  if (raw.content !== undefined) {
    if (typeof raw.content !== 'string' || !raw.content.trim() || raw.content.length > 100) {
      return fail('invalid_content');
    }
    value.content = raw.content.trim();
  }
  if (raw.keywords !== undefined) {
    const keywords = normalizeKeywords(raw.keywords);
    if (!keywords) return fail('invalid_keywords');
    value.keywords = keywords;
  }
  return { ok: true, value };
}

function normalizeSupersede(raw) {
  const allowed = new Set(['id', 'replacement']);
  if (unknownKeys(raw, allowed).length) return fail('unknown_field');
  const id = cleanId(raw.id);
  if (!id) return fail('missing_id');
  if (!isObject(raw.replacement)) return fail('invalid_replacement');
  const replacementAllowed = new Set([
    'content',
    'type',
    'keywords',
    'confidence',
    'validFrom',
    'validTo',
    'eventAt',
    'condition',
  ]);
  if (unknownKeys(raw.replacement, replacementAllowed).length) {
    return fail('unknown_replacement_field');
  }
  const content = typeof raw.replacement.content === 'string'
    ? raw.replacement.content.trim()
    : '';
  if (!content || content.length > 100) return fail('invalid_content');
  if (raw.replacement.type !== undefined && !ALLOWED_TYPES.has(raw.replacement.type)) {
    return fail('type_not_allowed');
  }
  if (raw.replacement.eventAt !== undefined && !validDate(raw.replacement.eventAt)) {
    return fail('invalid_event_at');
  }
  if (
    raw.replacement.condition !== undefined &&
    (typeof raw.replacement.condition !== 'string' || raw.replacement.condition.length > 80)
  ) {
    return fail('condition_too_long');
  }
  if (raw.replacement.keywords !== undefined) {
    if (!normalizeKeywords(raw.replacement.keywords)) return fail('invalid_keywords');
  }
  if (
    raw.replacement.confidence !== undefined &&
    (!Number.isFinite(Number(raw.replacement.confidence)) ||
      Number(raw.replacement.confidence) < 0 ||
      Number(raw.replacement.confidence) > 1)
  ) {
    return fail('invalid_confidence');
  }
  if (raw.replacement.validFrom !== undefined && !validDate(raw.replacement.validFrom)) {
    return fail('invalid_valid_from');
  }
  if (raw.replacement.validTo !== undefined && !validDate(raw.replacement.validTo)) {
    return fail('invalid_valid_to');
  }
  return {
    ok: true,
    value: {
      id,
      replacement: {
        ...raw.replacement,
        content,
        ...(raw.replacement.type !== undefined ? { type: raw.replacement.type } : {}),
      },
    },
  };
}

function validate(operation, payload) {
  if (!OPERATIONS.includes(operation)) return fail('invalid_operation');
  if (!isObject(payload)) return fail('invalid_payload');
  switch (operation) {
    case 'update':
      return normalizeUpdate(payload);
    case 'merge':
      return normalizeMerge(payload);
    case 'supersede':
      return normalizeSupersede(payload);
    case 'archive':
    case 'delete': {
      const allowed = new Set(['id']);
      if (unknownKeys(payload, allowed).length) return fail('unknown_field');
      const id = cleanId(payload.id);
      return id ? { ok: true, value: { id } } : fail('missing_id');
    }
    case 'withdraw': {
      const allowed = new Set(['id', 'sessionId']);
      if (unknownKeys(payload, allowed).length) return fail('unknown_field');
      const id = cleanId(payload.id);
      if (!id) return fail('missing_id');
      if (payload.sessionId !== undefined && typeof payload.sessionId !== 'string') {
        return fail('invalid_session_id');
      }
      return {
        ok: true,
        value: {
          id,
          sessionId:
            typeof payload.sessionId === 'string' && payload.sessionId.trim()
              ? payload.sessionId.trim().slice(0, 120)
              : null,
        },
      };
    }
    default:
      return fail('invalid_operation');
  }
}

async function execute(operation, payload) {
  const checked = validate(operation, payload);
  if (!checked.ok) return { ok: false, code: checked.error };
  const value = checked.value;

  switch (operation) {
    case 'update':
      return memory.updateMemory(value);
    case 'merge':
      return memory.mergeMemories(value);
    case 'supersede':
      return memory.supersedeMemory(value);
    case 'archive':
      return memory.archiveMemory(value.id);
    case 'withdraw':
      return memory.withdrawMemory(value);
    case 'delete':
      return memory.deleteMemory({ id: value.id });
    default:
      return { ok: false, reason: 'invalid_operation' };
  }
}

function summarize(operation, result) {
  const safe = {
    operation,
    ok: result && result.reason === 'ok',
    reason: result && result.reason ? String(result.reason).slice(0, 80) : null,
  };
  for (const key of [
    'id',
    'targetId',
    'supersededId',
    'status',
    'merged',
    'removed',
    'updated',
    'withdrawn',
    'removedContributions',
    'archived',
  ]) {
    if (result && result[key] !== undefined) {
      safe[key] =
        typeof result[key] === 'string'
          ? result[key].slice(0, 120)
          : result[key];
    }
  }
  if (result && Array.isArray(result.supersededIds)) {
    safe.supersededIds = result.supersededIds.slice(0, 20);
  }
  return safe;
}

module.exports = {
  OPERATIONS,
  RISK,
  validate,
  execute,
  summarize,
};
