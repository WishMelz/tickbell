<script setup lang="ts">
import { computed, ref } from 'vue';
import { useResponsive } from '@/composables/useResponsive';
import { listTimezones } from '@/utils/time';

const GLOBAL_SENTINEL = '__GLOBAL__';

const props = withDefaults(
  defineProps<{
    modelValue: string | null;
    nullable?: boolean;
    globalTimezone?: string;
    label?: string;
    hint?: string;
    disabled?: boolean;
  }>(),
  {
    nullable: false,
    globalTimezone: 'UTC',
    label: '时区',
    hint: '',
    disabled: false,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string | null];
}>();

const { isMobile } = useResponsive();
const allZones = listTimezones();
const keyword = ref('');

interface ZoneOption {
  label: string;
  value: string;
}

/**
 * Quasar QSelect 会把 `value: null` 视作“未选中”，导致 fill-input 显示空白。
 * 这里内部统一用 GLOBAL_SENTINEL 映射 null，对外仍保持 `string | null`。
 */
const internalValue = computed<string | null>(() => {
  if (props.modelValue === null) {
    return props.nullable ? GLOBAL_SENTINEL : null;
  }
  return props.modelValue;
});

const filteredOptions = computed<ZoneOption[]>(() => {
  const q = keyword.value.trim().toLowerCase();
  const base: ZoneOption[] = props.nullable
    ? [{ label: `跟随全局时区（${props.globalTimezone}）`, value: GLOBAL_SENTINEL }]
    : [];
  const matches = allZones
    .filter((z) => !q || z.toLowerCase().includes(q))
    .slice(0, 80)
    .map((z) => ({ label: z, value: z }));
  if (props.nullable && q && !`跟随全局时区 ${props.globalTimezone}`.toLowerCase().includes(q)) {
    return matches;
  }
  return [...base, ...matches];
});

function onFilter(val: string, update: (fn: () => void) => void): void {
  update(() => {
    keyword.value = val;
  });
}

function onChange(val: string | null): void {
  if (val === GLOBAL_SENTINEL || val === null) {
    emit('update:modelValue', props.nullable ? null : props.globalTimezone);
    return;
  }
  emit('update:modelValue', val);
}
</script>

<template>
  <q-select
    :model-value="internalValue"
    :options="filteredOptions"
    option-label="label"
    option-value="value"
    emit-value
    map-options
    use-input
    fill-input
    hide-selected
    input-debounce="0"
    outlined
    dense
    :label="label"
    :hint="hint || undefined"
    :disable="disabled"
    :behavior="isMobile ? 'dialog' : 'menu'"
    @filter="onFilter"
    @update:model-value="onChange"
  >
    <template #no-option>
      <q-item>
        <q-item-section class="text-muted">没有匹配的时区</q-item-section>
      </q-item>
    </template>
  </q-select>
</template>
