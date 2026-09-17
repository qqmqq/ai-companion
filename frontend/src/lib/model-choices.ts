/**
 * 模型选择的纯逻辑（与 React 无关，便于直接跑测试）。
 *
 * 关键约定：
 * - `ModelChoice.id` 才是**发给 Provider / 存数据库**的值；`name` 只用于显示。
 * - 任何来源（/api/models、/providers/:id/test、第三方结构）的模型数据都先经过 normalizeModelChoices，
 *   绝不把整个模型对象塞进 <option value>，也不把显示名当模型 id。
 */
export interface ModelChoice {
  id: string;
  name: string;
}

/** 认得出 id/model/name 三种命名的模型对象，也接受纯字符串；其余一律忽略 */
export function normalizeModelChoices(raw: unknown): ModelChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry === "string") {
      const id = entry.trim();
      if (id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: id });
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const idCandidate = [record.id, record.model, record.name].find((value) => typeof value === "string" && value.trim().length > 0);
    if (typeof idCandidate !== "string") continue;
    const id = idCandidate.trim();
    if (seen.has(id)) continue;
    const labelCandidate = [record.displayName, record.name].find((value) => typeof value === "string" && value.trim().length > 0);
    seen.add(id);
    out.push({ id, name: typeof labelCandidate === "string" ? labelCandidate.trim() : id });
  }
  return out;
}

/** 打开页面时：已配置的模型优先，其次用路由解析出来的实际模型 */
export function initialModelValue(input: { configured: string | null; resolved: string | null }): string {
  return (input.configured ?? input.resolved ?? "").trim();
}

/**
 * 换 Provider：**绝不能**把上一个 Provider 的模型名带过去。
 * 优先用新 Provider 的默认模型（若它在候选里），否则用候选第一条，再否则用它的默认模型字符串。
 */
export function modelAfterProviderChange(choices: ModelChoice[], nextProviderDefaultModel: string): string {
  const fallback = nextProviderDefaultModel.trim();
  if (fallback.length > 0 && choices.some((choice) => choice.id === fallback)) return fallback;
  if (choices.length > 0) return choices[0]!.id;
  return fallback;
}

/**
 * 刷新模型列表之后：用户当前的选择**只要还在**就原样保留；
 * 即使它已经不在列表里也保留（很多服务不列全部模型，手填的值更不能被悄悄改掉）。
 * 只有在"当前压根没有值"时，才自动选中列表第一项。
 */
export function modelAfterRefresh(choices: ModelChoice[], current: string): string {
  const trimmed = current.trim();
  if (trimmed.length > 0) return trimmed;
  return choices[0]?.id ?? "";
}

/** 当前值是否能在候选列表里找到（决定 select 能不能直接显示它） */
export function isKnownChoice(choices: ModelChoice[], value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && choices.some((choice) => choice.id === trimmed);
}

export type ModelInputMode = "list" | "manual";

/**
 * 只要有候选就渲染真正的下拉（当前值不在候选里时，把它作为额外的一项显示出来）。
 *
 * 这里曾经写成"当前值不在候选里就退回输入框"，结果是最常见的情况——Provider 的默认模型
 * 刚好没被 /v1/models 列出来——用户看到的永远是输入框，**取到了模型列表也点不了**。
 * 只有当候选为空、或用户主动选了「手填模型名」时，才用输入框。
 */
export function resolveModelMode(choices: ModelChoice[], value: string): ModelInputMode {
  void value;
  return choices.length === 0 ? "manual" : "list";
}

/** 送给 /api/model-routing 的值：空字符串 = 让 Provider 用默认模型（null） */
export function toRouteModel(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
