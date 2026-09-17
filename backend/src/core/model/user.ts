import type { UserId } from "./ids.ts";

export interface User {
  id: UserId;
  displayName: string;
  locale: string;
  timezone: string;
  createdAt: string;
}
