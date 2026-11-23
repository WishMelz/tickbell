<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import {
  api,
  type ChannelView,
  type ReminderInput,
  type ReminderTestResult,
  type ReminderView,
  type RepeatUnit,
} from '@/api';
import LocalDateTimePicker from '@/components/LocalDateTimePicker.vue';
import TimezoneSelect from '@/components/TimezoneSelect.vue';
import { notifyError, notifySuccess, useResponsive } from '@/composables/useResponsive';
import { icons } from '@/icons';
import { useSettingsStore } from '@/stores/settings';
import { CONTENT_HTML_LIMIT, CONTENT_TEXT_LIMIT, contentHtmlToText, plainTextToContentHtml } from '@/utils/content';
import { LOCAL_DATETIME_RE, nowLocalIn } from '@/utils/time';

// 懒加载 TipTap 编辑器，保持首屏包体积轻量
const RichContentEditor = defineAsyncComponent(() => import('@/components/RichContentEditor.vue'));

const props = defineProps<{
  modelValue: boolean;
  reminder: ReminderView | null;
  channels: ChannelView[];
  existingCategories: string[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [reminder: ReminderView];
}>();

const { isMobile } = useResponsive();
const settings = useSettingsStore();

const saving = ref(false);
const testing = ref(false);
const testResults = ref<ReminderTestResult[]>([]);

const title = ref('');
const contentHtml = ref('');
const contentText = ref('');
const category = ref('');
const tags = ref<string[]>([]);
const scheduledLocal = ref('');
const timezone = ref<string | null>(null);
const isRepeating = ref(false);
const repeatEvery = ref<number>(1);
const repeatUnit = ref<RepeatUnit>('day');
const channelIds = ref<string[]>([]);
const enabled = ref(true);

const isEdit = computed(() => props.reminder !== null);
const effectiveTimezone = computed(() => timezone.value ?? settings.globalTimezone);

const repeatUnitOptions: Array<{ label: string; value: RepeatUnit }> = [
  { label: '分钟', value: 'minute' },
  { label: '小时', value: 'hour' },
  { label: '天', value: 'day' },
  { label: '个月', value: 'month' },
  { label: '年', value: 'year' },
];

const categoryFilter = ref('');
const categoryOptions = computed(() => {
  const q = categoryFilter.value.trim().toLowerCase();
  return props.existingCategories.filter((c) => c && (!q || c.toLowerCase().includes(q)));
});

const channelOptions = computed(() =>
  props.channels.map((ch) => {
    const usable = ch.supported && ch.enabled && ch.configured;
    let reason = '';
    if (!ch.supported) reason = '暂不支持的类型';
    else if (!ch.enabled) reason = '已停用';
    else if (!ch.configured) reason = '未完成配置';
    return {
      label: reason ? `${ch.name}（${reason}）` : ch.name,
      value: ch.id,
      disable: !usable && !channelIds.value.includes(ch.id),
      usable,
      reason,
      type: ch.type,
    };
  }),
);

watch(
  () => [props.modelValue, props.reminder] as const,
  ([open]) => {
    if (!open) return;
    testResults.value = [];
    if (props.reminder) {
      title.value = props.reminder.title;
      contentHtml.value = props.reminder.contentHtml ?? plainTextToContentHtml(props.reminder.content);
      contentText.value = props.reminder.content;
      category.value = props.reminder.category;
      tags.value = [...props.reminder.tags];
      scheduledLocal.value = props.reminder.scheduledLocal;
      timezone.value = props.reminder.usesGlobalTimezone ? null : props.reminder.timezone;
      isRepeating.value = props.reminder.isRepeating;
      repeatEvery.value = props.reminder.repeatEvery ?? 1;
      repeatUnit.value = props.reminder.repeatUnit ?? 'day';
      channelIds.value = [...props.reminder.channelIds];
      enabled.value = props.reminder.enabled;
    } else {
      title.value = '';
      contentHtml.value = '';
      contentText.value = '';
      category.value = '';
      tags.value = [];
      timezone.value = null;
      scheduledLocal.value = nowLocalIn(settings.globalTimezone, 10);
      isRepeating.value = false;
      repeatEvery.value = 1;
      repeatUnit.value = 'day';
      const defaultUsable = props.channels.filter((c) => c.supported && c.enabled && c.configured);
      channelIds.value = defaultUsable.length === 1 ? [defaultUsable[0]!.id] : [];
      enabled.value = true;
    }
  },
  { immediate: true },
);

function filterCategories(val: string, update: (fn: () => void) => void): void {
  update(() => {
    categoryFilter.value = val;
  });
}

function addTag(val: string, done: (item?: string, mode?: 'add' | 'add-unique' | 'toggle') => void): void {
  const cleaned = val.trim();
  if (!cleaned) {
    done();
    return;
  }
  if (cleaned.length > 30) {
    notifyError('单个标签不能超过 30 个字符');
    done();
    return;
  }
  if (tags.value.length >= 10 && !tags.value.includes(cleaned)) {
    notifyError('最多只能添加 10 个标签');
    done();
    return;
  }
  done(cleaned, 'add-unique');
}

function buildInput(): ReminderInput | null {
  const trimmedTitle = title.value.trim();
  if (!trimmedTitle || trimmedTitle.length > 120) {
    notifyError('标题长度必须为 1 到 120 个字符');
    return null;
  }
  const plain = contentText.value || contentHtmlToText(contentHtml.value);
  if (plain.length > CONTENT_TEXT_LIMIT) {
    notifyError(`正文不能超过 ${CONTENT_TEXT_LIMIT} 个字符`);
    return null;
  }
  if (contentHtml.value.length > CONTENT_HTML_LIMIT) {
    notifyError('富文本格式过多，请精简');
    return null;
  }
  const cleanedCategory = (category.value ?? '').trim();
  if (cleanedCategory.length > 80) {
    notifyError('分类不能超过 80 个字符');
    return null;
  }
  if (!LOCAL_DATETIME_RE.test(scheduledLocal.value)) {
    notifyError('请选择有效的提醒时间（YYYY-MM-DD HH:mm）');
    return null;
  }
  if (isRepeating.value) {
    const n = Number(repeatEvery.value);
    if (!Number.isInteger(n) || n < 1 || n > 9999) {
      notifyError('重复间隔必须是 1 到 9999 的整数');
      return null;
    }
  }
  if (channelIds.value.length === 0) {
    notifyError('请至少选择一个通知渠道');
    return null;
  }

  return {
    title: trimmedTitle,
    content: plain,
    contentHtml: plain ? contentHtml.value : null,
    category: cleanedCategory,
    tags: tags.value,
    scheduledLocal: scheduledLocal.value,
    timezone: timezone.value,
    isRepeating: isRepeating.value,
    repeatEvery: isRepeating.value ? Number(repeatEvery.value) : null,
    repeatUnit: isRepeating.value ? repeatUnit.value : null,
    channelIds: [...channelIds.value],
    enabled: isEdit.value ? undefined : enabled.value,
  };
}

async function handleSave(): Promise<void> {
  const input = buildInput();
  if (!input) return;

  saving.value = true;
  try {
    const saved = props.reminder
      ? await api.updateReminder(props.reminder.id, input)
      : await api.createReminder(input);
    notifySuccess(props.reminder ? '提醒已更新' : '提醒已创建');
    emit('saved', saved);
    emit('update:modelValue', false);
  } catch (error) {
    notifyError(error, '保存提醒失败');
  } finally {
    saving.value = false;
  }
}

async function handleTest(): Promise<void> {
  const input = buildInput();
  if (!input) return;

  testing.value = true;
  testResults.value = [];
  try {
    testResults.value = await api.testReminder(input);
    const allOk = testResults.value.every((r) => r.ok);
    if (allOk) {
      notifySuccess('测试通知已全部发送成功');
    } else {
      notifyError('部分渠道测试发送失败，请查看下方详情');
    }
  } catch (error) {
    notifyError(error, '测试发送失败');
  } finally {
    testing.value = false;
  }
}

function close(): void {
  if (!saving.value) emit('update:modelValue', false);
}
</script>

<template>
  <q-dialog
    :model-value="modelValue"
    :maximized="isMobile"
    :position="isMobile ? 'standard' : 'right'"
    :class="{ 'side-dialog': !isMobile }"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <q-card class="editor-card">
      <div class="editor-head">
        <q-btn v-if="isMobile" flat round :icon="icons.close" aria-label="关闭" class="touch-44" :disable="saving" @click="close" />
        <div class="editor-title" :class="{ 'q-pl-sm': !isMobile }">{{ isEdit ? '编辑提醒' : '新建提醒' }}</div>
        <q-btn v-if="isMobile" flat no-caps color="primary" label="保存" class="touch-44" :loading="saving" @click="handleSave" />
        <q-btn v-else flat round :icon="icons.close" aria-label="关闭" class="touch-44" :disable="saving" @click="close" />
      </div>

      <div class="editor-body">
        <div class="form-stack">
          <q-input
            v-model="title"
            outlined
            dense
            maxlength="120"
            counter
            label="标题 *"
            placeholder="例如：交水电费、吃药提醒"
            :disable="saving"
          />

          <div>
            <div class="field-label">内容</div>
            <RichContentEditor
              v-if="modelValue"
              v-model="contentHtml"
              :disabled="saving"
              @text-change="contentText = $event"
            />
          </div>

          <div class="two-col">
            <LocalDateTimePicker
              v-model="scheduledLocal"
              :timezone="effectiveTimezone"
              label="首次提醒时间 *"
              :hint="`按 ${effectiveTimezone} 解释`"
              :disabled="saving"
            />
            <TimezoneSelect
              v-model="timezone"
              nullable
              :global-timezone="settings.globalTimezone"
              label="提醒时区"
              :disabled="saving"
            />
          </div>

          <div class="repeat-box">
            <div class="repeat-head">
              <div>
                <div class="repeat-title">重复提醒</div>
                <div class="field-hint">按月 / 年重复会自动锚定首次日期（如 31 日在小月取月末）</div>
              </div>
              <q-toggle v-model="isRepeating" color="primary" :disable="saving" />
            </div>
            <div v-if="isRepeating" class="repeat-fields">
              <span class="text-muted">每</span>
              <q-input
                v-model.number="repeatEvery"
                type="number"
                outlined
                dense
                min="1"
                max="9999"
                class="repeat-num"
                :disable="saving"
              />
              <q-select
                v-model="repeatUnit"
                :options="repeatUnitOptions"
                option-label="label"
                option-value="value"
                emit-value
                map-options
                outlined
                dense
                class="repeat-unit"
                :behavior="isMobile ? 'dialog' : 'menu'"
                :disable="saving"
              />
              <span class="text-muted">重复一次</span>
            </div>
          </div>

          <q-select
            v-model="channelIds"
            :options="channelOptions"
            option-label="label"
            option-value="value"
            option-disable="disable"
            emit-value
            map-options
            multiple
            use-chips
            outlined
            dense
            label="通知渠道 *"
            :behavior="isMobile ? 'dialog' : 'menu'"
            :disable="saving"
          >
            <template #no-option>
              <q-item>
                <q-item-section class="text-muted">暂无渠道，请先在「通知渠道」中创建推送渠道</q-item-section>
              </q-item>
            </template>
          </q-select>

          <div class="two-col">
            <q-select
              :model-value="category"
              :options="categoryOptions"
              use-input
              hide-selected
              fill-input
              new-value-mode="add"
              input-debounce="0"
              outlined
              dense
              clearable
              label="分类（可选）"
              :behavior="isMobile ? 'dialog' : 'menu'"
              :disable="saving"
              @filter="filterCategories"
              @update:model-value="category = $event == null ? '' : String($event)"
              @input-value="category = $event"
            />

            <q-select
              v-model="tags"
              use-input
              use-chips
              multiple
              hide-dropdown-icon
              input-debounce="0"
              outlined
              dense
              label="标签（回车添加，最多 10 个）"
              :disable="saving"
              @new-value="addTag"
            />
          </div>

          <div v-if="!isEdit" class="repeat-head">
            <div>
              <div class="repeat-title">创建后立即启用</div>
              <div class="field-hint">关闭则保存为暂停状态</div>
            </div>
            <q-toggle v-model="enabled" color="primary" :disable="saving" />
          </div>

          <!-- 移动端将测试按钮放在表单底部，避免顶栏拥挤 -->
          <div v-if="isMobile" class="q-pt-xs">
            <q-btn
              outline
              no-caps
              color="primary"
              class="full-width touch-44"
              :icon="icons.send"
              label="测试发送（不保存）"
              :loading="testing"
              :disable="saving"
              @click="handleTest"
            />
          </div>

          <div v-if="testResults.length" class="test-results">
            <div class="field-label">测试发送结果</div>
            <div v-for="item in testResults" :key="item.channelId" class="test-row">
              <q-icon
                :name="item.ok ? icons.checkCircle : icons.error"
                :color="item.ok ? 'positive' : 'negative'"
                size="18px"
              />
              <span class="test-name">{{ item.channelName }}</span>
              <span class="test-msg" :class="item.ok ? 'text-positive' : 'text-negative'">
                {{ item.ok ? '发送成功' : item.error || '发送失败' }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="!isMobile" class="editor-foot">
        <q-btn
          outline
          no-caps
          color="primary"
          :icon="icons.send"
          label="测试发送"
          :loading="testing"
          :disable="saving"
          @click="handleTest"
        />
        <q-space />
        <q-btn flat no-caps label="取消" :disable="saving" @click="close" />
        <q-btn unelevated no-caps color="primary" label="保存提醒" :loading="saving" @click="handleSave" />
      </div>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.form-stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.two-col {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  @media (max-width: 640px) {
    grid-template-columns: 1fr;
  }
}
.repeat-box {
  padding: 12px 14px;
  border-radius: var(--app-radius-sm);
  border: 1px solid var(--app-border);
  background: var(--app-surface-2);
}
.repeat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.repeat-title {
  font-size: 14px;
  font-weight: 550;
}
.repeat-fields {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.repeat-num {
  width: 96px;
}
.repeat-unit {
  width: 112px;
}
.test-results {
  padding: 12px;
  border-radius: var(--app-radius-sm);
  border: 1px solid var(--app-border);
  background: var(--app-surface-2);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.test-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.test-name {
  font-weight: 550;
}
.test-msg {
  flex: 1;
  overflow-wrap: anywhere;
}
</style>
