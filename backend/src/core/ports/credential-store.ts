export interface CredentialRecord {
  accountId: string;
  updatedAt: string;
}

/**
 * 凭据只写不读：
 * - 读取接口只在渠道层内部使用（getSecret），永不出现在 API DTO 中；
 * - 任何日志/审计都只允许记录 has* 与 updatedAt。
 */
export interface CredentialStore {
  putSecret(accountId: string, secret: Record<string, unknown>): Promise<void>;
  getSecret(accountId: string): Promise<Record<string, unknown> | null>;
  hasSecret(accountId: string): Promise<boolean>;
  deleteSecret(accountId: string): Promise<void>;
  listAccounts(): Promise<CredentialRecord[]>;
}
