const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;

/**
 * 粗略 token 估算：中日韩字符约 1 token/字，其余按 4 字符 ≈ 1 token。
 * 目的只是预算分配与快照可解释性，不追求与具体分词器完全一致
 * （需要精确值时以 provider 返回的 usage 为准）。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

export function estimateMessagesTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
}
