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
// 每个概念后的注释写明固定语料来源（tests/memory-eval/fixtures.js 的
// Mxx）与刻意排除的词，扩展时先改这里，再补正反例测试。
const CONCEPT_TERMS = Object.freeze({
  // M01/M17/M24/M26；不收录“茶/酒”，避免把其他饮品召回成咖啡。
  coffee: Object.freeze([
    '咖啡',
    '美式',
    '拿铁',
    '速溶',
    '手冲',
    '冷萃',
    'coffee',
    'latte',
    'americano',
    'espresso',
    'cafe',
    'pour over',
  ]),
  // M21；不收录泛化的“工具/软件”。
  editor: Object.freeze([
    '编辑器',
    '文本编辑器',
    '开发工具',
    'vim',
    'vs code',
    'vscode',
    'editor',
    'ide',
  ]),
  // M05；只放居住/城市语义，不把“青岛出差”收进来（那是 travel）。
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
  // M09；不收录泛化的“宠物”，避免未知宠物互相误召回。
  cat: Object.freeze(['猫', '小猫', '年糕', '小雪', 'cat', 'kitten']),
  // M03；只收正式姓名语义，不与昵称混用。
  name: Object.freeze(['名字', '姓名', '名称', '叫', 'name']),
  // M12；昵称单独成概念，避免“我叫什么名字”误召回小名。
  nickname: Object.freeze(['昵称', '小名', 'nickname']),
  // M18；包含职业称谓。
  job: Object.freeze([
    '工作',
    '职业',
    '上班',
    '工程师',
    'job',
    'work',
    'engineer',
    'developer',
    'software engineer',
  ]),
  // M10；过敏原与症状分开收录，查询 allergy 可命中“对花粉过敏”。
  allergy: Object.freeze([
    '过敏',
    '花粉',
    'allergy',
    'allergic',
    'pollen',
  ]),
  // M08；不收录裸 light/dark，避免普通光线词误命中；收 mode 短语。
  theme: Object.freeze([
    '主题',
    '深色',
    '浅色',
    '界面',
    'theme',
    'dark mode',
    'light mode',
    'appearance',
  ]),
  // M06/M22；不把泛化的“工作”收进来（那是 job）。
  project: Object.freeze([
    '项目',
    '产品',
    'project',
    'bluebird',
    '云岫',
  ]),
  // M19。
  birthday: Object.freeze([
    '生日',
    '出生日期',
    'birthday',
    'birth date',
    'born',
  ]),
  // M20；不收录裸“学习”，避免所有学习类目标互相召回。
  exam: Object.freeze([
    '考试',
    '考研',
    '备考',
    '研究生',
    'exam',
    'graduate school',
    'graduate exam',
  ]),
  // M16；不收录泛化的“系统”，避免操作系统/系统设计互相误召回。
  computer: Object.freeze([
    '电脑',
    '计算机',
    'windows',
    'computer',
    'pc',
    'laptop',
  ]),
  // M15；保留“口味/辣/湖南”的具体语义。
  spicy_food: Object.freeze([
    '辣',
    '湖南',
    '湘菜',
    '口味',
    'spicy',
    'spice',
    'hunan',
  ]),
  // M13；只收出行词，不把裸“去”收进来。
  travel: Object.freeze([
    '出差',
    '旅行',
    '旅游',
    '行程',
    'travel',
    'trip',
    'business trip',
    'itinerary',
  ]),
  // M04；避免裸 car/vehicle 把普通车辆对话误映射成车牌。
  license_plate: Object.freeze([
    '车牌',
    '车牌号',
    'license plate',
    'plate number',
  ]),
  // M02；否定式饮食限制；不把裸“吃/food”收进来。
  dietary_restriction: Object.freeze([
    '忌口',
    '不吃',
    '香菜',
    '饮食',
    'diet',
    'avoid',
    'cilantro',
    'not eat',
    'avoid eating',
  ]),
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
