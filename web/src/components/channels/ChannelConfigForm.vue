<script setup lang="ts">
import { computed, reactive } from 'vue';
import type { ChannelField } from '@/api/types';
import { useResponsive } from '@/composables/useResponsive';
import { icons } from '@/icons';

const props = defineProps<{
  fields: ChannelField[];
  modelValue: Record<string, unknown>;
  secretsSet: string[];
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: Record<string, unknown>];
}>();

const { isMobile } = useResponsive();
const revealed = reactive<Record<string, boolean>>({});

function isVisible(field: ChannelField): boolean {
  const cond = field.showWhen;
  if (!cond) return true;
  const current = props.modelValue[cond.field];
  if (cond.in && !cond.in.includes(current)) return false;
  if (cond.notIn && cond.notIn.includes(current)) return false;
  return true;
}

/** 按 field.group 将可见字段分组，方便清晰区分「连接与鉴权」与「通知配置」 */
const fieldSections = computed(() => {
  const sections: Array<{ title: string; items: ChannelField[] }> = [];
  for (const field of props.fields) {
    if (!isVisible(field)) continue;
    const title = field.group ?? '';
    const last = sections[sections.length - 1];
    if (last && last.title === title) {
      last.items.push(field);
    } else {
      sections.push({ title, items: [field] });
    }
  }
  return sections;
});

function setField(key: string, value: unknown): void {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

function placeholderFor(field: ChannelField): string | undefined {
  if (field.secret && props.secretsSet.includes(field.key)) {
    return '已设置，留空保持不变';
  }
  return field.placeholder;
}

function toStringVal(val: unknown): string {
  return val === undefined || val === null ? '' : String(val);
}

function toNumberVal(val: unknown): number | null {
  if (val === undefined || val === null || val === '') return null;
  const num = Number(val);
  return Number.isNaN(num) ? null : num;
}
</script>

<template>
  <div class="config-sections">
    <div v-for="(section, idx) in fieldSections" :key="`${section.title}-${idx}`" class="config-section">
      <div v-if="section.title" class="section-heading">{{ section.title }}</div>
      <div class="config-form">
        <div v-for="field in section.items" :key="field.key" class="config-field">
          <!-- Switch -->
          <div v-if="field.control === 'switch'" class="switch-row">
            <div>
              <div class="switch-label">{{ field.label }}</div>
              <div v-if="field.help" class="field-hint">{{ field.help }}</div>
            </div>
            <q-toggle
              :model-value="Boolean(modelValue[field.key])"
              color="primary"
              :disable="disabled"
              @update:model-value="setField(field.key, $event)"
            />
          </div>

          <!-- Select -->
          <q-select
            v-else-if="field.control === 'select'"
            :model-value="modelValue[field.key]"
            :options="field.options ?? []"
            option-label="label"
            option-value="value"
            emit-value
            map-options
            outlined
            dense
            :label="field.required ? `${field.label} *` : field.label"
            :hint="field.help"
            :disable="disabled"
            :behavior="isMobile ? 'dialog' : 'menu'"
            @update:model-value="setField(field.key, $event)"
          />

          <!-- Number -->
          <q-input
            v-else-if="field.control === 'number'"
            :model-value="toNumberVal(modelValue[field.key])"
            type="number"
            outlined
            dense
            :min="field.min"
            :max="field.max"
            :label="field.required ? `${field.label} *` : field.label"
            :hint="field.help"
            :disable="disabled"
            @update:model-value="setField(field.key, $event === '' || $event === null ? undefined : Number($event))"
          />

          <!-- Password / Secret -->
          <q-input
            v-else-if="field.control === 'password'"
            :model-value="toStringVal(modelValue[field.key])"
            :type="revealed[field.key] ? 'text' : 'password'"
            outlined
            dense
            autocomplete="off"
            :label="field.required ? `${field.label} *` : field.label"
            :placeholder="placeholderFor(field)"
            :hint="field.help"
            :disable="disabled"
            @update:model-value="setField(field.key, $event)"
          >
            <template #append>
              <q-btn
                flat
                round
                dense
                :icon="revealed[field.key] ? icons.visibilityOff : icons.visibility"
                aria-label="切换显示"
                @click="revealed[field.key] = !revealed[field.key]"
              />
            </template>
          </q-input>

          <!-- Textarea -->
          <q-input
            v-else-if="field.control === 'textarea'"
            :model-value="toStringVal(modelValue[field.key])"
            type="textarea"
            autogrow
            outlined
            dense
            :label="field.required ? `${field.label} *` : field.label"
            :placeholder="placeholderFor(field)"
            :hint="field.help"
            :disable="disabled"
            @update:model-value="setField(field.key, $event)"
          />

          <!-- URL / Text -->
          <q-input
            v-else
            :model-value="toStringVal(modelValue[field.key])"
            :type="field.control === 'url' ? 'url' : 'text'"
            outlined
            dense
            :label="field.required ? `${field.label} *` : field.label"
            :placeholder="placeholderFor(field)"
            :hint="field.help"
            :disable="disabled"
            @update:model-value="setField(field.key, $event)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.config-sections {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.config-section {
  padding: 14px;
  border-radius: var(--app-radius-sm);
  border: 1px solid var(--app-border);
  background: var(--app-surface-2);
}
.section-heading {
  font-size: 13px;
  font-weight: 650;
  color: var(--app-text-2);
  margin-bottom: 12px;
}
.config-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 2px;
}
.switch-label {
  font-size: 14px;
  color: var(--app-text);
}
</style>
