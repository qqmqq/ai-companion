-- Phase 5：会话冻结角色版本（编辑角色卡不会改变已有对话的行为 + Phase 5 的 SillyTavern 兼容字段都在 definition_json 里，无需额外列）
ALTER TABLE conversations ADD COLUMN character_version_id TEXT;
