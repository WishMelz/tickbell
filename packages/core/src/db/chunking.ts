import type { SqlStatement } from '../ports/index';

const MAX_SQL_BYTES = 90_000;
const textEncoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).length;
}

export function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
  if (items.length === 0) return [];
  const size = Math.max(1, Math.floor(chunkSize));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Splits a `WHERE col IN (?, ?, ...)` query into statements strictly respecting `maxBindParams`.
 */
export function buildChunkedInStatements(
  sqlPrefix: string,
  sqlSuffix: string,
  ids: readonly string[],
  maxBindParams: number,
  extraParamsBefore: readonly unknown[] = [],
  extraParamsAfter: readonly unknown[] = [],
): SqlStatement[] {
  if (ids.length === 0) return [];
  const budget = Math.max(1, maxBindParams - extraParamsBefore.length - extraParamsAfter.length);
  return chunkArray(ids, budget).map((chunk) => {
    const placeholders = chunk.map(() => '?').join(',');
    return {
      sql: `${sqlPrefix}(${placeholders})${sqlSuffix}`,
      params: [...extraParamsBefore, ...chunk, ...extraParamsAfter],
    };
  });
}

/**
 * Splits a multi-row INSERT into statements respecting BOTH `maxBindParams` (D1 limit: 100)
 * and `MAX_SQL_BYTES` (D1 limit: 100KB).
 */
export function buildMultiRowInsertStatements(
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
  maxBindParams: number,
  insertPrefix: 'INSERT INTO' | 'INSERT OR IGNORE INTO' = 'INSERT INTO',
): SqlStatement[] {
  if (rows.length === 0) return [];
  const colsPerRow = columns.length;
  const maxRowsByParams = Math.max(1, Math.floor(maxBindParams / colsPerRow));
  const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`;
  const header = `${insertPrefix} ${table} (${columns.join(', ')}) VALUES `;
  const headerBytes = utf8ByteLength(header);
  const rowPlaceholderBytes = utf8ByteLength(rowPlaceholder) + 2;

  const statements: SqlStatement[] = [];
  let currentPlaceholders: string[] = [];
  let currentParams: unknown[] = [];
  let currentBytes = headerBytes;

  const flush = () => {
    if (currentPlaceholders.length === 0) return;
    statements.push({
      sql: `${header}${currentPlaceholders.join(', ')}`,
      params: currentParams,
    });
    currentPlaceholders = [];
    currentParams = [];
    currentBytes = headerBytes;
  };

  for (const row of rows) {
    if (
      currentPlaceholders.length >= maxRowsByParams
      || (currentPlaceholders.length > 0 && currentBytes + rowPlaceholderBytes > MAX_SQL_BYTES)
    ) {
      flush();
    }
    currentPlaceholders.push(rowPlaceholder);
    currentParams.push(...row);
    currentBytes += rowPlaceholderBytes;
  }
  flush();

  return statements;
}
