const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;

/**
 * 把中日韩字符逐字切分（其余保持原样），让 unicode61 分词器能够命中任意长度的中文查询。
 * trigram 分词器对 2 字查询无效，因此不使用它。
 */
export function segmentText(text: string): string {
  let out = "";
  for (const ch of text.toLowerCase()) {
    if (CJK.test(ch)) out += ` ${ch} `;
    else out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * 把用户查询转成 FTS5 查询：词之间用 OR。
 *
 * 不能用 AND：中文经逐字切分后，"今天想喝点咖啡" 会变成 7 个字面项，
 * AND 语义要求全部命中，导致"用户喜欢手冲咖啡"这类相关记忆一条都检索不到。
 * OR 保证召回，相关性由 bm25 + 重要性 + 时间衰减排序决定。
 */
export function buildFtsQuery(text: string, maxTerms = 16): string | null {
  const segmented = segmentText(text);
  if (segmented.length === 0) return null;
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of segmented.split(" ")) {
    if (term.length === 0 || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= maxTerms) break;
  }
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replace(/"/g, "")}"`).join(" OR ");
}
