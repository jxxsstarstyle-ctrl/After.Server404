// helpers para match textual: tokens + jaccard similarity
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function jaccard(aTokens, bTokens) {
  const A = new Set(aTokens);
  const B = new Set(bTokens);
  const intersection = new Set([...A].filter(x => B.has(x)));
  const union = new Set([...A, ...B]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

module.exports = { tokenize, jaccard };
