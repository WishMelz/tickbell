import { ValidationError } from '../../common/errors';
import {
  CONTENT_HTML_LIMIT,
  CONTENT_TEXT_LIMIT,
  contentHtmlToText,
  sanitizeContentHtml,
} from '../../common/reminder-content';
import { REPEAT_UNITS, type RepeatUnit } from '../../common/repeat';
import { isValidTimezone, localDateTimeToEpoch } from '../../common/time';

export interface ValidatedReminderInput {
  title: string;
  content: string;
  contentHtml: string | null;
  category: string;
  tags: string[];
  scheduledLocal: string;
  timezone: string | null;
  isRepeating: boolean;
  repeatEvery: number | null;
  repeatUnit: RepeatUnit | null;
  channelIds: string[];
  enabled: boolean;
}

export type ReminderBatchAction = 'enable' | 'disable' | 'delete' | 'channels';

export type ValidatedReminderBatchInput =
  | { ids: string[]; action: 'enable' | 'disable' | 'delete' }
  | { ids: string[]; action: 'channels'; channelIds: string[] };

function assertObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('请求体必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function parseTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ValidationError('标签格式无效');
  }
  const tags = [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (tags.length > 10) {
    throw new ValidationError('标签不能超过 10 个');
  }
  if (tags.some((tag) => tag.length > 30)) {
    throw new ValidationError('单个标签不能超过 30 个字符');
  }
  return tags;
}

export function validateReminderInput(
  value: unknown,
  globalTimezone: string,
): {
  input: ValidatedReminderInput;
  startsAt: number;
  effectiveTimezone: string;
} {
  const body = assertObject(value);
  const title = optionalTrimmedString(body.title) ?? '';

  if (body.contentHtml !== undefined && body.contentHtml !== null && typeof body.contentHtml !== 'string') {
    throw new ValidationError('富文本内容格式无效');
  }
  if (typeof body.contentHtml === 'string' && body.contentHtml.length > CONTENT_HTML_LIMIT) {
    throw new ValidationError('富文本格式过多，请精简内容格式');
  }

  let contentHtml = typeof body.contentHtml === 'string' ? sanitizeContentHtml(body.contentHtml) : null;
  if (contentHtml && contentHtml.length > CONTENT_HTML_LIMIT) {
    throw new ValidationError('富文本格式过多，请精简内容格式');
  }
  const content =
    contentHtml !== null
      ? contentHtmlToText(contentHtml)
      : typeof body.content === 'string'
        ? body.content.trim()
        : '';
  if (!content) contentHtml = null;

  const category = optionalTrimmedString(body.category) ?? '';
  const tags = parseTags(body.tags);
  const scheduledLocal = optionalTrimmedString(body.scheduledLocal) ?? '';
  const timezoneValue = body.timezone === null ? null : optionalTrimmedString(body.timezone);
  const timezone = timezoneValue || null;
  const effectiveTimezone = timezone ?? globalTimezone;

  const isRepeating = body.isRepeating === true;
  const repeatEvery = typeof body.repeatEvery === 'number' ? body.repeatEvery : null;
  const repeatUnit =
    typeof body.repeatUnit === 'string' && (REPEAT_UNITS as readonly string[]).includes(body.repeatUnit)
      ? (body.repeatUnit as RepeatUnit)
      : null;

  const channelIds = Array.isArray(body.channelIds)
    ? [
        ...new Set(
          body.channelIds
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .map((item) => item.trim()),
        ),
      ]
    : [];

  const enabled = body.enabled !== false;

  if (!title || title.length > 120) {
    throw new ValidationError('标题长度必须为 1 到 120 个字符');
  }
  if (content.length > CONTENT_TEXT_LIMIT) {
    throw new ValidationError('内容不能超过 4000 个字符');
  }
  if (category.length > 80) {
    throw new ValidationError('分类不能超过 80 个字符');
  }
  if (!isValidTimezone(effectiveTimezone)) {
    throw new ValidationError('时区无效');
  }
  if (channelIds.length === 0) {
    throw new ValidationError('至少选择一个通知渠道');
  }
  if (
    isRepeating
    && (!Number.isInteger(repeatEvery) || (repeatEvery ?? 0) < 1 || (repeatEvery ?? 0) > 9999 || !repeatUnit)
  ) {
    throw new ValidationError('重复间隔必须是 1 到 9999 的整数，并选择重复单位');
  }

  let startsAt: number;
  try {
    startsAt = localDateTimeToEpoch(scheduledLocal, effectiveTimezone);
  } catch {
    throw new ValidationError('提醒时间格式无效');
  }

  return {
    input: {
      title,
      content,
      contentHtml,
      category,
      tags,
      scheduledLocal,
      timezone,
      isRepeating,
      repeatEvery: isRepeating ? repeatEvery : null,
      repeatUnit: isRepeating ? repeatUnit : null,
      channelIds,
      enabled,
    },
    startsAt,
    effectiveTimezone,
  };
}

export function validateReminderBatchInput(value: unknown): ValidatedReminderBatchInput {
  const body = assertObject(value);

  const parseIds = (raw: unknown, label: string, max?: number): string[] => {
    if (
      !Array.isArray(raw)
      || raw.length === 0
      || (max !== undefined && raw.length > max)
      || raw.some((item) => typeof item !== 'string' || !item.trim() || item.trim().length > 128)
    ) {
      throw new ValidationError(
        max !== undefined ? `${label}必须包含 1 到 ${max} 个有效 ID` : `${label}必须包含至少 1 个有效 ID`,
      );
    }
    return [...new Set((raw as string[]).map((item) => item.trim()))];
  };

  const ids = parseIds(body.ids, '提醒列表');
  if (body.action === 'enable' || body.action === 'disable' || body.action === 'delete') {
    return { ids, action: body.action };
  }
  if (body.action === 'channels') {
    return { ids, action: 'channels', channelIds: parseIds(body.channelIds, '通知渠道列表', 100) };
  }
  throw new ValidationError('批量操作类型无效');
}
