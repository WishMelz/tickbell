<script setup lang="ts">
import { computed, ref } from 'vue';
import { useResponsive } from '@/composables/useResponsive';
import { icons } from '@/icons';
import { LOCAL_DATETIME_RE } from '@/utils/time';

/**
 * 本地日期时间选择器（输出/输入严格为 YYYY-MM-DDTHH:mm 字符串）。
 * 绝不通过 new Date() 换算，保证提醒自身时区与浏览器时区不同时也能准确设置。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    label?: string;
    hint?: string;
    errorMessage?: string;
    disabled?: boolean;
  }>(),
  {
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
const activeTab = ref<'date' | 'time'>('date');

const parts = computed(() => {
  const match = LOCAL_DATETIME_RE.exec(props.modelValue);
  if (match) {
    return { date: `${match[1]}-${match[2]}-${match[3]}`, time: `${match[4]}:${match[5]}` };
  }
  return { date: '', time: '09:00' };
});

const displayValue = computed(() => (props.modelValue ? props.modelValue.replace('T', ' ') : ''));

function updateDate(date: string | null): void {
  if (!date) return;
  const time = parts.value.time || '09:00';
  emit('update:modelValue', `${date}T${time}`);
  if (isMobile.value) {
    activeTab.value = 'time';
  }
}

function updateTime(time: string | null): void {
  if (!time) return;
  const date = parts.value.date;
  if (!date) return;
  emit('update:modelValue', `${date}T${time}`);
}

function onManualInput(raw: string | number | null): void {
  const str = String(raw ?? '').trim().replace(' ', 'T');
  emit('update:modelValue', str);
}

function openPicker(tab: 'date' | 'time' = 'date'): void {
  if (props.disabled) return;
  activeTab.value = tab;
  pickerOpen.value = true;
}
</script>

<template>
  <div>
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
      @click="isMobile && openPicker('date')"
    >
      <template #prepend>
        <q-btn
          flat
          round
          dense
          :icon="icons.event"
          aria-label="选择日期"
          :disable="disabled"
          @click.stop="openPicker('date')"
        />
      </template>
      <template #append>
        <q-btn
          flat
          round
          dense
          :icon="icons.schedule"
          aria-label="选择时间"
          :disable="disabled"
          @click.stop="openPicker('time')"
        />
      </template>
    </q-input>

    <!-- 移动端和 PC 共用弹窗（移动端从底部弹出更易触控，PC 居中紧凑显示） -->
    <q-dialog v-model="pickerOpen" :position="isMobile ? 'bottom' : 'standard'">
      <q-card class="dt-card">
        <div class="dt-head">
          <q-tabs v-model="activeTab" dense active-color="primary" indicator-color="primary" align="left">
            <q-tab name="date" :icon="icons.event" label="日期" />
            <q-tab name="time" :icon="icons.schedule" label="时间" />
          </q-tabs>
          <q-btn flat no-caps color="primary" label="完成" @click="pickerOpen = false" />
        </div>
        <q-tab-panels v-model="activeTab" animated class="dt-panels">
          <q-tab-panel name="date" class="q-pa-none">
            <q-date
              :model-value="parts.date"
              mask="YYYY-MM-DD"
              flat
              class="full-width"
              @update:model-value="updateDate"
            />
          </q-tab-panel>
          <q-tab-panel name="time" class="q-pa-none">
            <q-time
              :model-value="parts.time"
              mask="HH:mm"
              format24h
              flat
              class="full-width"
              @update:model-value="updateTime"
            />
          </q-tab-panel>
        </q-tab-panels>
      </q-card>
    </q-dialog>
  </div>
</template>

<style scoped lang="scss">
.dt-card {
  width: 340px;
  max-width: 100vw;
  background: var(--app-surface);
  color: var(--app-text);
  padding-bottom: var(--safe-bottom);
}
.dt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  border-bottom: 1px solid var(--app-border);
}
.dt-panels {
  background: var(--app-surface);
}
</style>
