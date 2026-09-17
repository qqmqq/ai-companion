import type { ChannelKind } from "../model/channel.ts";
import type { ChannelAdapter } from "./channel.ts";

/** Core 通过注册表按 kind 找到渠道；不认识的渠道直接返回 undefined。 */
export interface ChannelRegistry {
  get(kind: ChannelKind): ChannelAdapter | undefined;
  list(): ChannelAdapter[];
}
