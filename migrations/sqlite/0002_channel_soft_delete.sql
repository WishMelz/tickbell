-- TickBell 2.0: allow deleting channels that are referenced by historical delivery logs
-- while preserving channel name/type in deliveries.

ALTER TABLE channels ADD COLUMN deleted_at INTEGER;
