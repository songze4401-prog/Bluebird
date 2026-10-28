/**
 * 本地概念级语义召回（memory-semantic.js）
 *
 * 本模块解决的是“同义改写 / 上下位 / 跨语言词面完全不同”的召回问题：
 * 把文本映射到稳定 concept（如 coffee / city / editor），再按 concept 重合
 * 计算语义分。它不依赖外部 API、向量数据库或模型推理。
 *
 * 重要边界：这是**词典驱动的概念语义**，不是神经 embedding / 向量语义。
 * 仓库当前没有本地嵌入模型或推理依赖（见 docs/memory-semantic.md），
 * 因此开放域语义、词典未覆盖的同义词和语言仍是阻塞项；结果里用
 * semanticKind='concept_lexicon_v1'、neural=false、limited=true 明确标注，
 * 不把字符二元组或未覆盖的词冒充成向量语义。
 */

const SEMANTIC_PROVIDER = Object.freeze({
  id: 'local-concept-lexicon',
  version: 'v1',
  neural: false,
  limited: true,
  kind: 'concept_lexicon_v1',
  blocked: 'neural_embedding_not_available',
  note:
    '词典驱动的同义/上下位/跨语言概念匹配；不是神经 embedding，词典未覆盖的表达仍可能召回失败',
});

// 只收录可解释的具体概念；不要把“喜欢/偏好”这类泛化词收进来，
// 否则任何 preference 条目都会被语义分普遍抬高。
const CONCEPT_TERMS = Object.freeze({
  coffee: Object.freeze([
    '咖啡',
    '美式',
    '拿铁',
    '速溶',
    'coffee',
    'latte',
    'americano',
    'espresso',
    'cafe',
  ]),
  editor: Object.freeze([
    '编辑器',
    'vim',
    'vs code',
    'vscode',
    'editor',
    'ide',
  ]),
  city: Object.freeze([
    '城市',
    '住在',
    '居住',
    '杭州',
    '上海',
    '北京',
    'city',
    'live',
    'hangzhou',
    'shanghai',
    'beijing',
  ]),
  cat: Object.freeze(['猫', '年糕', 'cat', 'kitten']),
  name: Object.freeze(['名字', '叫', 'name']),
  job: Object.freeze(['工作', '职业', '上班', 'job', 'work']),
});

const CJK_RE = /[\u3400-\u9fff]/;

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,
      ' '
    )
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesTerm(text, term) {
  const normalizedTerm = normalizeText(term);

  if (!normalizedTerm) return false;

  if (CJK_RE.test(normalizedTerm)) {
    return text.includes(normalizedTerm);
  }

  const re = new RegExp(
    `(^|[^a-z0-9])${escapeRegExp(normalizedTerm)}($|[^a-z0-9])`
  );

  return re.test(text);
}

/**
 * 返回 Map<concept, matchedTerms[]>。同一概念在一个文本里只记一次，
 * 但保留实际命中的词典词，便于结果解释。
 */
function extractConcepts(value) {
  const text = normalizeText(value);
  const result = new Map();

  for (const [concept, terms] of Object.entries(CONCEPT_TERMS)) {
    const matched = terms.filter(term => matchesTerm(text, term));

    if (matched.length) result.set(concept, matched);
  }

  return result;
}

function emptyProfile() {
  return {
    concepts: [],
    queryConcepts: [],
    memoryConcepts: [],
    evidence: [],
    score: 0,
    coverage: 0,
    precision: 0,
    provider: SEMANTIC_PROVIDER.id,
    kind: SEMANTIC_PROVIDER.kind,
    neural: false,
    limited: true,
    blocked: SEMANTIC_PROVIDER.blocked,
  };
}

function semanticProfile(value) {
  const concepts = extractConcepts(value);

  return {
    ...emptyProfile(),
    concepts: [...concepts.keys()],
    evidence: [...concepts.entries()].map(([concept, terms]) => ({
      concept,
      terms,
    })),
  };
}

/**
 * query 与 memory 的概念重合分：
 *   coverage  = 命中 query 概念数 / query 概念数
 *   precision = 命中概念数 / memory 概念数
 *   score     = 0.7 * coverage + 0.3 * precision
 * 只要双方命中同一 concept 就得到非 0 分；词面是否重合不影响这个分项。
 */
function semanticSimilarity(query, memoryText, keywords = []) {
  const queryConcepts = extractConcepts(query);
  const memoryConcepts = extractConcepts(
    [memoryText, ...(Array.isArray(keywords) ? keywords : [])].join(' ')
  );

  if (!queryConcepts.size || !memoryConcepts.size) {
    return emptyProfile();
  }

  const queryIds = [...queryConcepts.keys()];
  const memoryIds = [...memoryConcepts.keys()];
  const shared = queryIds.filter(concept => memoryConcepts.has(concept));

  if (!shared.length) {
    return {
      ...emptyProfile(),
      queryConcepts: queryIds,
      memoryConcepts: memoryIds,
    };
  }

  const coverage = shared.length / queryIds.length;
  const precision = shared.length / memoryIds.length;
  const score = Math.min(1, coverage * 0.7 + precision * 0.3);

  return {
    concepts: shared,
    queryConcepts: queryIds,
    memoryConcepts: memoryIds,
    evidence: shared.map(concept => ({
      concept,
      queryTerms: queryConcepts.get(concept),
      memoryTerms: memoryConcepts.get(concept),
    })),
    score,
    coverage,
    precision,
    provider: SEMANTIC_PROVIDER.id,
    kind: SEMANTIC_PROVIDER.kind,
    neural: false,
    limited: true,
    blocked: SEMANTIC_PROVIDER.blocked,
  };
}

function semanticCapability() {
  return {
    ...SEMANTIC_PROVIDER,
    provider: SEMANTIC_PROVIDER.id,
    concepts: Object.keys(CONCEPT_TERMS),
    conceptCount: Object.keys(CONCEPT_TERMS).length,
  };
}

module.exports = {
  SEMANTIC_PROVIDER,
  CONCEPT_TERMS,
  normalizeText,
  extractConcepts,
  semanticProfile,
  semanticSimilarity,
  semanticCapability,
};
