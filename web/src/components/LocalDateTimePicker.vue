<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useResponsive } from '@/composables/useResponsive';
import { icons } from '@/icons';
import { browserTimezone, LOCAL_DATETIME_RE, nowLocalIn } from '@/utils/time';

/**
 * 本地日期时间选择器（输出/输入严格为 YYYY-MM-DDTHH:mm 字符串）。
 * - PC：输入框下方浮层，左侧精简月历 + 右侧双列「时 / 分」滚动直选 + 底部快捷时间。
 * - H5：底部抽屉，一屏同时选日期与「时 / 分」，无需切换标签、告别环形表盘。
 * 绝不通过 new Date() 换算本地时刻，保证跨时区设置准确。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    timezone?: string;
    label?: string;
    hint?: string;
    errorMessage?: string;
    disabled?: boolean;
  }>(),
  {
    timezone: '',
    label: '提醒时间',
    hint: '',
    errorMessage: '',
    disabled: false,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const { isMobile } = useResponsive();
const pickerOpen = ref(false);
const hourListEl = ref<HTMLElement | null>(null);
const minuteListEl = ref<HTMLElement | null>(null);

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

const effectiveTz = computed(() => props.timezone || browserTimezone());

const parts = computed(() => {
  const match = LOCAL_DATETIME_RE.exec(props.modelValue);
  if (match) {
    return {
      date: `${match[1]}-${match[2]}-${match[3]}`,
      hour: match[4]!,
      minute: match[5]!,
    };
  }
  const fallback = nowLocalIn(effectiveTz.value, 10);
  const fbMatch = LOCAL_DATETIME_RE.exec(fallback);
  return {
    date: fbMatch ? `${fbMatch[1]}-${fbMatch[2]}-${fbMatch[3]}` : '2026-01-01',
    hour: fbMatch?.[4] ?? '09',
    minute: fbMatch?.[5] ?? '00',
  };
});

const displayValue = computed(() => (props.modelValue ? props.modelValue.replace('T', ' ') : ''));

function emitParts(date: string, hour: string, minute: string): void {
  emit('update:modelValue', `${date}T${hour}:${minute}`);
}

function updateDate(date: string | null): void {
  if (!date) return;
  emitParts(date, parts.value.hour, parts.value.minute);
}

function selectHour(hour: string): void {
  emitParts(parts.value.date, hour, parts.value.minute);
}

function selectMinute(minute: string): void {
  emitParts(parts.value.date, parts.value.hour, minute);
}

function applyPreset(kind: '10m' | '1h' | 'tomorrow9'): void {
  if (kind === '10m') {
    emit('update:modelValue', nowLocalIn(effectiveTz.value, 10));
  } else if (kind === '1h') {
    emit('update:modelValue', nowLocalIn(effectiveTz.value, 60));
  } else {
    // 明天 09:00（在目标时区下加 24 小时取日期，再固定 09:00）
    const tomorrow = nowLocalIn(effectiveTz.value, 24 * 60).slice(0, 10);
    emit('update:modelValue', `${tomorrow}T09:00`);
  }
  void scrollActiveIntoView(true);
}

function onManualInput(raw: string | number | null): void {
  const str = String(raw ?? '').trim().replace(' ', 'T');
  emit('update:modelValue', str);
}

async function scrollActiveIntoView(smooth = false): Promise<void> {
  await nextTick();
  const behavior: ScrollBehavior = smooth ? 'smooth' : 'instant';
  for (const container of [hourListEl.value, minuteListEl.value]) {
    if (!container) continue;
    const active = container.querySelector<HTMLElement>('.time-cell--active');
    if (active) {
      const targetTop = active.offsetTop - container.clientHeight / 2 + active.clientHeight / 2;
      container.scrollTo({ top: Math.max(0, targetTop), behavior });
    }
  }
}

watch(pickerOpen, (open) => {
  if (open) {
    // 等待 q-menu / q-dialog 完成挂载后定位到当前选中的时/分
    setTimeout(() => {
      void scrollActiveIntoView(false);
    }, 30);
  }
});

function openPicker(): void {
  if (props.disabled) return;
  pickerOpen.value = true;
}
</script>

<template>
  <div class="dt-field">
    <q-input
      :model-value="displayValue"
      outlined
      dense
      :label="label"
      placeholder="YYYY-MM-DD HH:mm"
      :hint="hint || undefined"
      :error="Boolean(errorMessage)"
      :error-message="errorMessage || undefined"
      :disable="disabled"
      :readonly="isMobile"
      @update:model-value="onManualInput"
      @click="isMobile && openPicker()"
    >
      <template #append>
        <q-btn
          flat
          round
          dense
          :icon="icons.event"
          aria-label="选择日期和时间"
          :disable="disabled"
          @click.stop="openPicker()"
        />
      </template>

      <!-- PC：输入框下方轻量浮层（不遮挡整个抽屉） -->
      <q-menu
        v-if="!isMobile"
        v-model="pickerOpen"
        no-parent-event
        anchor="bottom left"
        self="top left"
        :offset="[0, 6]"
        class="dt-menu"
      >
        <div class="dt-panel">
          <div class="dt-body">
            <q-date
              :model-value="parts.date"
              mask="YYYY-MM-DD"
              minimal
              flat
              first-day-of-week="1"
              class="dt-calendar"
              @update:model-value="updateDate"
            />
            <div class="dt-time-wrap">
              <div class="dt-time-head">
                <span>时</span>
                <span>分</span>
              </div>
              <div class="dt-time-cols">
                <div ref="hourListEl" class="time-col">
                  <button
                    v-for="h in HOURS"
                    :key="h"
                    type="button"
                    class="time-cell"
                    :class="{ 'time-cell--active': h === parts.hour }"
                    @click="selectHour(h)"
                  >
                    {{ h }}
                  </button>
                </div>
                <div ref="minuteListEl" class="time-col">
                  <button
                    v-for="m in MINUTES"
                    :key="m"
                    type="button"
                    class="time-cell"
                    :class="{ 'time-cell--active': m === parts.minute }"
                    @click="selectMinute(m)"
                  >
                    {{ m }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="dt-foot">
            <div class="dt-presets">
              <button type="button" class="preset-btn" @click="applyPreset('10m')">10分钟后</button>
              <button type="button" class="preset-btn" @click="applyPreset('1h')">1小时后</button>
              <button type="button" class="preset-btn" @click="applyPreset('tomorrow9')">明天 09:00</button>
            </div>
            <q-btn unelevated dense no-caps color="primary" label="确定" class="q-px-md" @click="pickerOpen = false" />
          </div>
        </div>
      </q-menu>
    </q-input>

    <!-- 移动端 H5：底部抽屉，一屏同时选日期 + 时/分 -->
    <q-dialog v-if="isMobile" v-model="pickerOpen" position="bottom">
      <q-card class="dt-sheet">
        <div class="dt-sheet-head">
          <div class="dt-preview">{{ parts.date }} {{ parts.hour }}:{{ parts.minute }}</div>
          <q-btn flat no-caps color="primary" label="完成" class="touch-44" @click="pickerOpen = false" />
        </div>

        <div class="dt-presets dt-presets--mobile">
          <button type="button" class="preset-btn" @click="applyPreset('10m')">10分钟后</button>
          <button type="button" class="preset-btn" @click="applyPreset('1h')">1小时后</button>
          <button type="button" class="preset-btn" @click="applyPreset('tomorrow9')">明天 09:00</button>
        </div>

        <q-date
          :model-value="parts.date"
          mask="YYYY-MM-DD"
          minimal
          flat
          first-day-of-week="1"
          class="dt-calendar dt-calendar--mobile"
          @update:model-value="updateDate"
        />

        <div class="dt-time-wrap dt-time-wrap--mobile">
          <div class="dt-time-head">
            <span>小时（{{ parts.hour }}）</span>
            <span>分钟（{{ parts.minute }}）</span>
          </div>
          <div class="dt-time-cols dt-time-cols--mobile">
            <div ref="hourListEl" class="time-col">
              <button
                v-for="h in HOURS"
                :key="h"
                type="button"
                class="time-cell time-cell--mobile"
                :class="{ 'time-cell--active': h === parts.hour }"
                @click="selectHour(h)"
              >
                {{ h }} 时
              </button>
            </div>
            <div ref="minuteListEl" class="time-col">
              <button
                v-for="m in MINUTES"
                :key="m"
                type="button"
                class="time-cell time-cell--mobile"
                :class="{ 'time-cell--active': m === parts.minute }"
                @click="selectMinute(m)"
              >
                {{ m }} 分
              </button>
            </div>
          </div>
        </div>
      </q-card>
    </q-dialog>
  </div>
</template>

<style scoped lang="scss">
.dt-panel {
  background: var(--app-surface);
  color: var(--app-text);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  overflow: hidden;
  width: 422px;
  max-width: calc(100vw - 24px);
}
.dt-body {
  display: flex;
  align-items: stretch;
}
.dt-calendar {
  width: 280px;
  min-width: 280px;
  background: transparent;
  color: var(--app-text);
}
.dt-calendar--mobile {
  width: 100%;
  min-width: 0;
}
.dt-time-wrap {
  flex: 1;
  min-width: 136px;
  border-left: 1px solid var(--app-border);
  display: flex;
  flex-direction: column;
}
.dt-time-wrap--mobile {
  border-left: none;
  border-top: 1px solid var(--app-border);
}
.dt-time-head {
  display: grid;
  grid-template-columns: 1fr 1fr;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--app-text-2);
  padding: 10px 6px 8px;
  border-bottom: 1px solid var(--app-border);
}
.dt-time-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  height: 256px;
}
.dt-time-cols--mobile {
  height: 168px;
}
.time-col {
  overflow-y: auto;
  padding: 6px 5px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  scrollbar-width: thin;
  & + .time-col {
    border-left: 1px solid var(--app-border);
  }
}
.time-cell {
  border: none;
  background: transparent;
  color: var(--app-text);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  line-height: 28px;
  height: 28px;
  border-radius: 6px;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.12s ease, color 0.12s ease;
  &:hover {
    background: var(--app-surface-2);
  }
}
.time-cell--mobile {
  height: 36px;
  line-height: 36px;
  font-size: 14px;
}
.time-cell--active {
  background: var(--q-primary) !important;
  color: #fff !important;
  font-weight: 600;
}
.dt-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--app-border);
  background: var(--app-surface-2);
}
.dt-presets {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.dt-presets--mobile {
  padding: 8px 12px;
  border-bottom: 1px solid var(--app-border);
}
.preset-btn {
  border: 1px solid var(--app-border);
  background: var(--app-surface);
  color: var(--app-text-2);
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 999px;
  cursor: pointer;
  transition: border-color 0.12s ease, color 0.12s ease, background 0.12s ease;
  &:hover {
    border-color: var(--q-primary);
    color: var(--q-primary);
    background: var(--app-selected);
  }
}
.dt-sheet {
  width: 100%;
  max-width: 100vw;
  background: var(--app-surface);
  color: var(--app-text);
  border-radius: 16px 16px 0 0;
  padding-bottom: var(--safe-bottom);
}
.dt-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px 6px 16px;
  border-bottom: 1px solid var(--app-border);
}
.dt-preview {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
