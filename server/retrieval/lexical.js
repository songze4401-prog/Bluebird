/**
 * 云岫 Bluebird — 本地词法/精确索引（retrieval/lexical.js）
 *
 * 词法索引是派生的内存索引，从 chunk 内容重建，不单独落盘；BM25 参数固定，
 * 结果只用于排序，不作为事实可信度。精确索引覆盖代码标识符、文件路径、
 * 错误码和带引号短语，避免“只押注向量相似度”。
 */
const { tokenize, exactTerms } = require('./text');

const K1 = 1.2;
const B = 0.75;

function createLexicalIndex() {
  const docs = new Map();
  const postings = new Map();
  const exactPostings = new Map();
  let totalLength = 0;

  function addPosting(term, chunkId) {
    let list = postings.get(term);
    if (!list) {
      list = new Map();
      postings.set(term, list);
    }
    list.set(chunkId, (list.get(chunkId) || 0) + 1);
  }

  function removePosting(term, chunkId) {
    const list = postings.get(term);
    if (!list) return;
    list.delete(chunkId);
    if (!list.size) postings.delete(term);
  }

  function addExact(term, chunkId) {
    if (!term) return;
    let set = exactPostings.get(term);
    if (!set) {
      set = new Set();
      exactPostings.set(term, set);
    }
    set.add(chunkId);
  }

  function removeExact(term, chunkId) {
    const set = exactPostings.get(term);
    if (!set) return;
    set.delete(chunkId);
    if (!set.size) exactPostings.delete(term);
  }

  function add(chunk) {
    if (!chunk || !chunk.chunkId) return;
    remove(chunk.chunkId);

    const symbols = Array.isArray(chunk.metadata && chunk.metadata.symbols)
      ? chunk.metadata.symbols
      : [];
    const sourceText = [
      chunk.content,
      chunk.title,
      chunk.title,
      chunk.locator,
      symbols.join(' '),
    ].join('\n');
    const terms = tokenize(sourceText);
    const termFreq = new Map();

    for (const term of terms) {
      termFreq.set(term, (termFreq.get(term) || 0) + 1);
      addPosting(term, chunk.chunkId);
    }

    docs.set(chunk.chunkId, {
      chunk,
      termFreq,
      length: terms.length,
    });
    totalLength += terms.length;

    const exactSet = new Set([
      ...exactTerms(chunk.content, 48),
      ...exactTerms(chunk.title, 12),
      ...exactTerms(chunk.locator, 12),
      ...(Array.isArray(chunk.metadata && chunk.metadata.exactTerms)
        ? chunk.metadata.exactTerms
        : []),
      ...symbols,
    ]);
    for (const term of exactSet) {
      const normalized = String(term || '').trim().toLowerCase();
      if (normalized) addExact(normalized, chunk.chunkId);
    }
  }

  function remove(chunkId) {
    const doc = docs.get(chunkId);
    if (!doc) return;
    for (const term of doc.termFreq.keys()) removePosting(term, chunkId);
    const chunk = doc.chunk;
    const symbols = Array.isArray(chunk.metadata && chunk.metadata.symbols)
      ? chunk.metadata.symbols
      : [];
    const exactSet = new Set([
      ...exactTerms(chunk.content, 48),
      ...exactTerms(chunk.title, 12),
      ...exactTerms(chunk.locator, 12),
      ...(Array.isArray(chunk.metadata && chunk.metadata.exactTerms)
        ? chunk.metadata.exactTerms
        : []),
      ...symbols,
    ]);
    for (const term of exactSet) {
      const normalized = String(term || '').trim().toLowerCase();
      if (normalized) removeExact(normalized, chunkId);
    }
    totalLength -= doc.length;
    docs.delete(chunkId);
  }

  function rebuild(chunks) {
    docs.clear();
    postings.clear();
    exactPostings.clear();
    totalLength = 0;
    for (const chunk of chunks || []) add(chunk);
  }

  function search(query, { topK = 30, allow = null } = {}) {
    const terms = [...new Set(tokenize(query, 64))];
    if (!terms.length || !docs.size) return [];
    const totalDocs = docs.size;
    const avgLength = totalLength / totalDocs || 1;
    const scores = new Map();
    const matched = new Map();

    for (const term of terms) {
      const list = postings.get(term);
      if (!list) continue;
      const df = list.size;
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      for (const [chunkId, tf] of list) {
        const doc = docs.get(chunkId);
        if (!doc) continue;
        if (allow && !allow(doc.chunk)) continue;
        const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (doc.length / avgLength)));
        scores.set(chunkId, (scores.get(chunkId) || 0) + idf * norm);
        let listMatched = matched.get(chunkId);
        if (!listMatched) {
          listMatched = [];
          matched.set(chunkId, listMatched);
        }
        if (listMatched.length < 8) listMatched.push(term);
      }
    }

    return [...scores.entries()]
      .map(([chunkId, score]) => ({
        chunkId,
        chunk: docs.get(chunkId).chunk,
        score,
        matchedTerms: matched.get(chunkId) || [],
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  function searchExact(query, { topK = 30, allow = null } = {}) {
    const terms = exactTerms(query, 16);
    if (!terms.length || !exactPostings.size) return [];
    const scores = new Map();
    const matched = new Map();

    for (const term of terms) {
      const set = exactPostings.get(term);
      if (!set) continue;
      for (const chunkId of set) {
        const doc = docs.get(chunkId);
        if (!doc) continue;
        if (allow && !allow(doc.chunk)) continue;
        scores.set(chunkId, (scores.get(chunkId) || 0) + 1);
        let list = matched.get(chunkId);
        if (!list) {
          list = [];
          matched.set(chunkId, list);
        }
        if (list.length < 8) list.push(term);
      }
    }

    const queryText = String(query || '').toLowerCase();
    return [...scores.entries()]
      .map(([chunkId, score]) => {
        const chunk = docs.get(chunkId).chunk;
        const phrase =
          (chunk.title && queryText.includes(chunk.title.toLowerCase())) ||
          (chunk.locator && queryText.includes(chunk.locator.toLowerCase()));
        return {
          chunkId,
          chunk,
          score: score + (phrase ? 0.5 : 0),
          matchedTerms: matched.get(chunkId) || [],
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  return {
    add,
    remove,
    rebuild,
    search,
    searchExact,
    get size() {
      return docs.size;
    },
    stats() {
      return {
        chunks: docs.size,
        terms: postings.size,
        exactTerms: exactPostings.size,
        averageLength: docs.size ? Math.round(totalLength / docs.size) : 0,
      };
    },
  };
}

module.exports = { createLexicalIndex };
