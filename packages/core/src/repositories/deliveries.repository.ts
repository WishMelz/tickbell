import type { DbAdapter, SqlStatement } from '../ports/index';

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'retrying' | 'skipped';
export const DELIVERY_STATUSES: readonly DeliveryStatus[] = ['pending', 'sent', 'failed', 'retrying', 'skipped'];

export interface DeliveryRow {
  id: string;
  event_id: string;
  reminder_id: string;
  scheduled_at: number;
  channel_id: string;
  status: DeliveryStatus;
  attempts: number;
  next_retry_at: number | null;
  http_status: number | null;
  error: string | null;
  response_summary: string | null;
  sent_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface DeliveryJoinedRow extends DeliveryRow {
  reminder_title: string;
  channel_name: string;
  channel_type: string;
}

export interface DeliveryListQuery {
  reminderId?: string;
  channelId?: string;
  status?: DeliveryStatus;
  page: number;
  pageSize: number;
}

export class DeliveriesRepository {
  constructor(private readonly db: DbAdapter) {}

  async findPage(query: DeliveryListQuery): Promise<{ items: DeliveryJoinedRow[]; total: number }> {
    const clauses: string[] = ['1 = 1'];
    const bindings: unknown[] = [];

    if (query.reminderId) {
      clauses.push('d.reminder_id = ?');
      bindings.push(query.reminderId);
    }
    if (query.channelId) {
      clauses.push('d.channel_id = ?');
      bindings.push(query.channelId);
    }
    if (query.status) {
      clauses.push('d.status = ?');
      bindings.push(query.status);
    }

    const where = clauses.join(' AND ');
    const offset = (query.page - 1) * query.pageSize;

    const [totalRows, itemRows] = await this.db.batchQuery<Record<string, unknown>>([
      {
        sql: `SELECT COUNT(*) AS count FROM deliveries d WHERE ${where}`,
        params: bindings,
      },
      {
        sql: `SELECT d.*, r.title AS reminder_title, c.name AS channel_name, c.type AS channel_type
              FROM deliveries d
              JOIN reminders r ON r.id = d.reminder_id
              JOIN channels c ON c.id = d.channel_id
              WHERE ${where}
              ORDER BY d.created_at DESC
              LIMIT ? OFFSET ?`,
        params: [...bindings, query.pageSize, offset],
      },
    ]);

    return {
      items: (itemRows ?? []) as unknown as DeliveryJoinedRow[],
      total: Number((totalRows?.[0] as { count?: number } | undefined)?.count ?? 0),
    };
  }

  async findJoinedById(id: string): Promise<DeliveryJoinedRow | null> {
    return this.db.first<DeliveryJoinedRow>({
      sql: `SELECT d.*, r.title AS reminder_title, c.name AS channel_name, c.type AS channel_type
            FROM deliveries d
            JOIN reminders r ON r.id = d.reminder_id
            JOIN channels c ON c.id = d.channel_id
            WHERE d.id = ?`,
      params: [id],
    });
  }

  /**
   * Conditional idempotent claim statement safe to combine inside a `db.batch()` after an optimistic reminder advance.
   * Only inserts when the reminder matches `expectedVersionAfterAdvance` (proving the preceding advance succeeded)
   * and no receipt exists yet.
   */
  claimStatements(params: {
    id: string;
    eventId: string;
    reminderId: string;
    expectedVersionAfterAdvance: number;
    scheduledAt: number;
    channelId: string;
    status: 'pending' | 'skipped';
    error?: string | null;
    now: number;
  }): [SqlStatement, SqlStatement] {
    const insertDelivery: SqlStatement = {
      sql: `INSERT OR IGNORE INTO deliveries (
              id, event_id, reminder_id, scheduled_at, channel_id, status, attempts,
              error, created_at, updated_at
            )
            SELECT ?, ?, ?, ?, ?, ?, 0, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM reminders
              WHERE id = ? AND schedule_version = ? AND deleted_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM delivery_receipts
              WHERE reminder_id = ? AND scheduled_at = ? AND channel_id = ?
            )`,
      params: [
        params.id,
        params.eventId,
        params.reminderId,
        params.scheduledAt,
        params.channelId,
        params.status,
        params.error ?? null,
        params.now,
        params.now,
        params.reminderId,
        params.expectedVersionAfterAdvance,
        params.reminderId,
        params.scheduledAt,
        params.channelId,
      ],
    };

    const insertReceipt: SqlStatement = {
      sql: `INSERT OR IGNORE INTO delivery_receipts (reminder_id, scheduled_at, channel_id)
            SELECT reminder_id, scheduled_at, channel_id FROM deliveries WHERE id = ?`,
      params: [params.id],
    };

    return [insertDelivery, insertReceipt];
  }

  async recordAttemptResult(params: {
    id: string;
    status: 'sent' | 'failed' | 'retrying';
    nextRetryAt: number | null;
    httpStatus: number | null;
    error: string | null;
    responseSummary: string | null;
    sentAt: number | null;
    now: number;
  }): Promise<void> {
    await this.db.run({
      sql: `UPDATE deliveries SET
              status = ?,
              attempts = attempts + 1,
              next_retry_at = ?,
              http_status = ?,
              error = ?,
              response_summary = ?,
              sent_at = ?,
              updated_at = ?
            WHERE id = ?`,
      params: [
        params.status,
        params.nextRetryAt,
        params.httpStatus,
        params.error ? params.error.slice(0, 1000) : null,
        params.responseSummary ? params.responseSummary.slice(0, 1000) : null,
        params.sentAt,
        params.now,
        params.id,
      ],
    });
  }

  async markFailedWithoutAttempt(id: string, error: string, now: number): Promise<void> {
    await this.db.run({
      sql: `UPDATE deliveries SET status = 'failed', next_retry_at = NULL, error = ?, updated_at = ? WHERE id = ?`,
      params: [error.slice(0, 1000), now, id],
    });
  }

  async claimScheduledRetry(id: string, expectedAttempts: number, now: number): Promise<boolean> {
    const info = await this.db.run({
      sql: `UPDATE deliveries SET status = 'pending', next_retry_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'retrying' AND attempts = ?`,
      params: [now, id, expectedAttempts],
    });
    return info.changes > 0;
  }

  async claimManualRetry(id: string, now: number): Promise<boolean> {
    const info = await this.db.run({
      sql: `UPDATE deliveries SET status = 'pending', next_retry_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'failed'`,
      params: [now, id],
    });
    return info.changes > 0;
  }

  async findDueRetries(now: number, limit = 10): Promise<DeliveryRow[]> {
    return this.db.all<DeliveryRow>({
      sql: `SELECT * FROM deliveries
            WHERE status = 'retrying' AND next_retry_at IS NOT NULL AND next_retry_at <= ?
            ORDER BY next_retry_at ASC
            LIMIT ?`,
      params: [now, limit],
    });
  }

  async countRetrying(): Promise<number> {
    const row = await this.db.first<{ count: number }>({
      sql: `SELECT COUNT(*) AS count FROM deliveries WHERE status = 'retrying'`,
    });
    return Number(row?.count ?? 0);
  }

  async failStalePendingBefore(cutoffMs: number, reason: string, now: number): Promise<number> {
    const info = await this.db.run({
      sql: `UPDATE deliveries SET status = 'failed', next_retry_at = NULL, error = ?, updated_at = ?
            WHERE status = 'pending' AND updated_at <= ?`,
      params: [reason, now, cutoffMs],
    });
    return info.changes;
  }

  async failAllPending(reason: string, now: number): Promise<number> {
    const info = await this.db.run({
      sql: `UPDATE deliveries SET status = 'failed', next_retry_at = NULL, error = ?, updated_at = ?
            WHERE status = 'pending'`,
      params: [reason, now],
    });
    return info.changes;
  }

  async deleteOlderThan(cutoffMs: number): Promise<number> {
    const info = await this.db.run({
      sql: `DELETE FROM deliveries WHERE created_at < ? AND status IN ('sent', 'failed', 'skipped')`,
      params: [cutoffMs],
    });
    return info.changes;
  }
}
