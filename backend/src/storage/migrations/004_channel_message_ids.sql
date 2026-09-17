-- Phase 4：渠道消息幂等表。
-- 只存协议侧的消息标识（uint64 用 TEXT 保存，绝不经过 JS Number），用于去重；
-- 表名保持通用，渠道专有逻辑留在 channels/ 内。

CREATE TABLE channel_message_ids (
  channel TEXT NOT NULL,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (channel, account_id, message_id)
);
CREATE INDEX idx_channel_message_ids_seen ON channel_message_ids(seen_at);
