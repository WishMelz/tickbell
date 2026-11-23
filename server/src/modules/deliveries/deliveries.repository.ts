import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

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

@Injectable()
export class DeliveriesRepository {
  constructor(private readonly database: DatabaseService) {}

  findPage(query: DeliveryListQuery): { items: DeliveryJoinedRow[]; total: number } {
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
    const totalRow = this.database.db
      .prepare(`SELECT COUNT(*) AS count FROM deliveries d WHERE ${where}`)
      .get(...bindings) as { count: number };

    const offset = (query.page - 1) * query.pageSize;
    const items = this.database.db
      .prepare(
        `SELECT d.*, r.title AS reminder_title, c.name AS channel_name, c.type AS channel_type
         FROM deliveries d
         JOIN reminders r ON r.id = d.reminder_id
         JOIN channels c ON c.id = d.channel_id
         WHERE ${where}
         ORDER BY d.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...bindings, query.pageSize, offset) as DeliveryJoinedRow[];

    return { items, total: totalRow.count };
  }

  findJoinedById(id: string): DeliveryJoinedRow | null {
    const row = this.database.db
      .prepare(
        `SELECT d.*, r.title AS reminder_title, c.name AS channel_name, c.type AS channel_type
         FROM deliveries d
         JOIN reminders r ON r.id = d.reminder_id
         JOIN channels c ON c.id = d.channel_id
         WHERE d.id = ?`,
      )
      .get(id) as DeliveryJoinedRow | undefined;
    return row ?? null;
  }

  /**
   * Idempotent claim for a `(reminder_id, scheduled_at, channel_id)` delivery.
   * Respects both `deliveries` UNIQUE constraint and `delivery_receipts` history.
   * Returns true if claimed (inserted), false if already delivered/claimed.
   */
  claim(params: {
    id: string;
    eventId: string;
    reminderId: string;
    scheduledAt: number;
    channelId: string;
    status: 'pending' | 'skipped';
    error?: string | null;
    now: number;
  }): boolean {
    const info = this.database.db
      .prepare(
        `INSERT OR IGNORE INTO deliveries (
           id, event_id, reminder_id, scheduled_at, channel_id, status, attempts,
           error, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, 0, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM delivery_receipts
           WHERE reminder_id = ? AND scheduled_at = ? AND channel_id = ?
         )`,
      )
      .run(
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
        params.scheduledAt,
        params.channelId,
      );

    if (info.changes > 0) {
      this.database.db
        .prepare('INSERT OR IGNORE INTO delivery_receipts (reminder_id, scheduled_at, channel_id) VALUES (?, ?, ?)')
        .run(params.reminderId, params.scheduledAt, params.channelId);
      return true;
    }
    return false;
  }

  recordAttemptResult(params: {
    id: string;
    status: 'sent' | 'failed' | 'retrying';
    nextRetryAt: number | null;
    httpStatus: number | null;
    error: string | null;
    responseSummary: string | null;
    sentAt: number | null;
    now: number;
  }): void {
    this.database.db
      .prepare(
        `UPDATE deliveries SET
           status = ?,
           attempts = attempts + 1,
           next_retry_at = ?,
           http_status = ?,
           error = ?,
           response_summary = ?,
           sent_at = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        params.status,
        params.nextRetryAt,
        params.httpStatus,
        params.error ? params.error.slice(0, 1000) : null,
        params.responseSummary ? params.responseSummary.slice(0, 1000) : null,
        params.sentAt,
        params.now,
        params.id,
      );
  }

  markFailedWithoutAttempt(id: string, error: string, now: number): void {
    this.database.db
      .prepare(
        `UPDATE deliveries SET status = 'failed', next_retry_at = NULL, error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(error.slice(0, 1000), now, id);
  }

  findDueRetries(now: number, limit = 100): DeliveryRow[] {
    return this.database.db
      .prepare(
        `SELECT * FROM deliveries
         WHERE status = 'retrying' AND next_retry_at IS NOT NULL AND next_retry_at <= ?
         ORDER BY next_retry_at ASC
         LIMIT ?`,
      )
      .all(now, limit) as DeliveryRow[];
  }

  countRetrying(): number {
    const row = this.database.db
      .prepare(`SELECT COUNT(*) AS count FROM deliveries WHERE status = 'retrying'`)
      .get() as { count: number };
    return row.count;
  }

  failAllStalePending(reason: string, now: number): number {
    const info = this.database.db
      .prepare(
        `UPDATE deliveries SET status = 'failed', next_retry_at = NULL, error = ?, updated_at = ?
         WHERE status = 'pending'`,
      )
      .run(reason, now);
    return info.changes;
  }

  deleteOlderThan(cutoffMs: number): number {
    const info = this.database.db
      .prepare(`DELETE FROM deliveries WHERE created_at < ? AND status IN ('sent', 'failed', 'skipped')`)
      .run(cutoffMs);
    return info.changes;
  }
}
