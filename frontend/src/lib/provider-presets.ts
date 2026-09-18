/**
 * Provider 预设：一键填好常见自建服务的连接参数。
 *
 * ⚠️ baseUrl 不能带 /v1：我们的 provider 自己会拼 /v1/chat/completions 与 /v1/models，
 * 带上就会变成 /v1/v1/...（写错过一次，所以固化成数据 + 用例守住）。
 */
export interface ProviderPreset {
  kind: "openai-compatible" | "ollama" | "echo";
  displayName: string;
  baseUrl: string;
  defaultModel: string;
}

/**
 * 自建的 DeepSeek 网页反代（ds-free-api）：把请求转到本机代理，省掉 API 费用。
 * 代理自己的 API Key 在它的管理面板（http://127.0.0.1:22217/admin）里创建。
 * 详见 docs/DS-FREE-API-PROXY.md。
 */
export const DS_FREE_PROXY_PRESET: ProviderPreset = {
  kind: "openai-compatible",
  displayName: "DeepSeek 网页反代（本机）",
  baseUrl: "http://127.0.0.1:22217",
  defaultModel: "deepseek-default",
};
