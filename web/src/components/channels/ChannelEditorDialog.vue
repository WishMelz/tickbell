<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api, type ChannelType, type ChannelView, type ProxyView } from '@/api';
import { notifyError, notifySuccess, useResponsive } from '@/composables/useResponsive';
import { channelBrand, icons } from '@/icons';
import ChannelConfigForm from './ChannelConfigForm.vue';
import { channelFormOverrides } from './channelFormOverrides';

const props = defineProps<{
  modelValue: boolean;
  channel: ChannelView | null;
  channelTypes: ChannelType[];
  proxies: ProxyView[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [channel: ChannelView];
}>();

const { isMobile } = useResponsive();
const saving = ref(false);
const name = ref('');
const type = ref('');
const enabled = ref(true);
const proxyId = ref<string | null>(null);
const config = ref<Record<string, unknown>>({});

const isEdit = computed(() => props.channel !== null);
const isUnsupported = computed(() => Boolean(props.channel && !props.channel.supported));
const activeType = computed(() => props.channelTypes.find((t) => t.type === type.value) ?? null);
const FormComponent = computed(() => channelFormOverrides[type.value] ?? ChannelConfigForm);

const proxyOptions = computed(() => [
  {
    label: '不使用代理（直连）',
    value: null as string | null,
    caption: '直接从本机发起网络请求',
    disabled: false,
  },
  ...props.proxies.map((p) => ({
    label: p.enabled ? `${p.name}（${p.protocol.toUpperCase()}）` : `${p.name}（${p.protocol.toUpperCase()} · 已停用）`,
    value: p.id as string | null,
    caption: `${p.protocol}://${p.host}:${p.port}`,
    disabled: !p.enabled,
  })),
]);

function buildInitialConfig(desc: ChannelType | null, existing: Record<string, unknown> | null): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of desc?.fields ?? []) {
    if (existing && existing[field.key] !== undefined) {
      result[field.key] = existing[field.key];
    } else if (field.default !== undefined) {
      result[field.key] = field.default;
    } else if (field.control === 'switch') {
      result[field.key] = false;
    } else {
      result[field.key] = '';
    }
  }
  return result;
}

watch(
  () => [props.modelValue, props.channel, props.channelTypes] as const,
  ([open]) => {
    if (!open) return;
    if (props.channel) {
      name.value = props.channel.name;
      type.value = props.channel.type;
      enabled.value = props.channel.enabled;
      proxyId.value = props.channel.proxyId ?? null;
      const desc = props.channelTypes.find((t) => t.type === props.channel!.type) ?? null;
      config.value = buildInitialConfig(desc, props.channel.config);
    } else {
      const firstType = props.channelTypes[0] ?? null;
      name.value = '';
      type.value = firstType?.type ?? '';
      enabled.value = true;
      proxyId.value = null;
      config.value = buildInitialConfig(firstType, null);
    }
  },
  { immediate: true },
);

function onTypeChange(newType: string): void {
  type.value = newType;
  const desc = props.channelTypes.find((t) => t.type === newType) ?? null;
  config.value = buildInitialConfig(desc, null);
}

function buildPayloadConfig(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of activeType.value?.fields ?? []) {
    const val = config.value[field.key];
    if (field.secret && (val === '' || val === undefined || val === null)) {
      continue; // 留空表示保持原有密钥
    }
    if (field.control === 'number') {
      if (val === undefined || val === null || val === '') {
        out[field.key] = null; // 显式传 null 以支持编辑时清空可选数字字段
      } else {
        const num = Number(val);
        out[field.key] = Number.isFinite(num) ? num : val;
      }
    } else if (field.control === 'switch') {
      out[field.key] = Boolean(val);
    } else if (val !== undefined && val !== null) {
      out[field.key] = val;
    }
  }
  return out;
}

async function submit(): Promise<void> {
  const trimmedName = name.value.trim();
  if (!trimmedName || trimmedName.length > 80) {
    notifyError('渠道名称长度必须为 1 到 80 个字符');
    return;
  }
  if (!isEdit.value && !type.value) {
    notifyError('请选择通知渠道类型');
    return;
  }

  saving.value = true;
  try {
    let saved: ChannelView;
    if (props.channel) {
      saved = await api.updateChannel(
        props.channel.id,
        isUnsupported.value
          ? { name: trimmedName, enabled: false }
          : { name: trimmedName, enabled: enabled.value, proxyId: proxyId.value, config: buildPayloadConfig() },
      );
      notifySuccess('渠道已更新');
    } else {
      saved = await api.createChannel({
        name: trimmedName,
        type: type.value,
        enabled: enabled.value,
        proxyId: proxyId.value,
        config: buildPayloadConfig(),
      });
      notifySuccess('渠道已创建');
    }
    emit('saved', saved);
    emit('update:modelValue', false);
  } catch (error) {
    notifyError(error, '保存渠道失败');
  } finally {
    saving.value = false;
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
        <div class="editor-title" :class="{ 'q-pl-sm': !isMobile }">{{ isEdit ? '编辑通知渠道' : '新建通知渠道' }}</div>
        <q-btn v-if="isMobile" flat no-caps color="primary" label="保存" class="touch-44" :loading="saving" @click="submit" />
        <q-btn v-else flat round :icon="icons.close" aria-label="关闭" class="touch-44" :disable="saving" @click="close" />
      </div>

      <div class="editor-body">
        <q-banner v-if="isUnsupported" rounded class="q-mb-md unsupported-banner">
          该渠道类型（{{ channel?.type }}）当前版本暂不支持，保留原配置以便后续接入；目前只能修改名称或保持停用。
        </q-banner>

        <div class="form-stack">
          <q-select
            v-if="!isEdit"
            :model-value="type"
            :options="channelTypes"
            option-label="name"
            option-value="type"
            emit-value
            map-options
            outlined
            dense
            label="渠道类型 *"
            :behavior="isMobile ? 'dialog' : 'menu'"
            @update:model-value="onTypeChange"
          >
            <template #option="scope">
              <q-item v-bind="scope.itemProps">
                <q-item-section avatar style="min-width: 40px">
                  <span
                    class="type-icon-badge"
                    :style="{
                      color: channelBrand(scope.opt.type, scope.opt.icon).color,
                      background: channelBrand(scope.opt.type, scope.opt.icon).bg,
                    }"
                  >
                    <q-icon :name="channelBrand(scope.opt.type, scope.opt.icon).icon" size="18px" />
                  </span>
                </q-item-section>
                <q-item-section>
                  <q-item-label>{{ scope.opt.name }}</q-item-label>
                  <q-item-label caption>{{ scope.opt.description }}</q-item-label>
                </q-item-section>
              </q-item>
            </template>
          </q-select>

          <q-input
            v-model="name"
            outlined
            dense
            maxlength="80"
            label="渠道名称 *"
            placeholder="例如：我的 iPhone"
            :disable="saving"
          />

          <div class="enable-row">
            <div>
              <div class="enable-label">启用渠道</div>
              <div class="field-hint">关闭后关联提醒不会通过此渠道推送</div>
            </div>
            <q-toggle v-model="enabled" color="primary" :disable="saving || isUnsupported" />
          </div>

          <q-select
            v-if="!isUnsupported"
            v-model="proxyId"
            :options="proxyOptions"
            option-label="label"
            option-value="value"
            emit-value
            map-options
            outlined
            dense
            label="网络代理"
            hint="可在「系统设置 → 网络代理」中新增并校验代理"
            :behavior="isMobile ? 'dialog' : 'menu'"
            :disable="saving"
          >
            <template #option="scope">
              <q-item v-bind="scope.itemProps">
                <q-item-section>
                  <q-item-label :class="{ 'text-warning': scope.opt.disabled }">{{ scope.opt.label }}</q-item-label>
                  <q-item-label caption>{{ scope.opt.caption }}</q-item-label>
                </q-item-section>
              </q-item>
            </template>
          </q-select>

          <q-separator />

          <component
            :is="FormComponent"
            v-if="activeType && !isUnsupported"
            v-model="config"
            :fields="activeType.fields"
            :secrets-set="channel?.secretsSet ?? []"
            :disabled="saving"
          />
        </div>
      </div>

      <div v-if="!isMobile" class="editor-foot">
        <q-space />
        <q-btn flat no-caps label="取消" :disable="saving" @click="close" />
        <q-btn unelevated no-caps color="primary" label="保存渠道" :loading="saving" @click="submit" />
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
.enable-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.enable-label {
  font-size: 14px;
  font-weight: 550;
}
.unsupported-banner {
  background: color-mix(in srgb, var(--q-warning) 15%, transparent);
  color: var(--app-text);
  border: 1px solid color-mix(in srgb, var(--q-warning) 30%, transparent);
}
.type-icon-badge {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: grid;
  place-items: center;
}
</style>
