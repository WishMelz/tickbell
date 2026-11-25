<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import {
  api,
  type AutoBackupFileInfo,
  type AutoBackupIntervalUnit,
  type AutoBackupView,
  type BackupPreview,
} from '@/api';
import { confirmDialog } from '@/composables/dialogs';
import { notifyError, notifySuccess } from '@/composables/useResponsive';
import { icons } from '@/icons';
import { useSettingsStore } from '@/stores/settings';
import { saveTextFile } from '@/utils/download';
import {
  backupFileName,
  parsePlainBackupFile,
  serializePlainBackup,
} from '@/utils/fullBackup';
import { formatInstant } from '@/utils/time';

const props = withDefaults(
  defineProps<{
    diskAutoBackup?: boolean;
  }>(),
  {
    diskAutoBackup: true,
  },
);

const emit = defineEmits<{
  restored: [];
}>();

const settings = useSettingsStore();

// ---------- 手动导出下载（Node & Cloudflare 通用） ----------
const exportAdminPassword = ref('');
const exporting = ref(false);

async function runManualExport(): Promise<void> {
  if (!exportAdminPassword.value) {
    notifyError('请输入管理密码以导出备份');
    return;
  }
  exporting.value = true;
  try {
    const payload = await api.exportBackup(exportAdminPassword.value);
    saveTextFile(serializePlainBackup(payload), backupFileName());
    exportAdminPassword.value = '';
    notifySuccess('已导出并下载明文 JSON 备份');
  } catch (error) {
    notifyError(error, '导出备份失败');
  } finally {
    exporting.value = false;
  }
}

// ---------- 数据备份与自动备份（保存在 data/backups/） ----------
const autoLoading = ref(false);
const autoSaving = ref(false);
const autoRunning = ref(false);
const autoView = ref<AutoBackupView | null>(null);
const busyFileName = ref<string | null>(null);

const autoForm = reactive<{
  enabled: boolean;
  time: string;
  intervalEvery: number;
  intervalUnit: AutoBackupIntervalUnit;
  maxFiles: number;
}>({
  enabled: false,
  time: '03:00',
  intervalEvery: 1,
  intervalUnit: 'day',
  maxFiles: 10,
});

const intervalUnitOptions: Array<{ label: string; value: AutoBackupIntervalUnit }> = [
  { label: '天', value: 'day' },
  { label: '小时', value: 'hour' },
];

const autoDirty = computed(() => {
  const saved = autoView.value?.config;
  if (!saved) return false;
  return (
    autoForm.enabled !== saved.enabled ||
    String(autoForm.time ?? '').trim() !== saved.time ||
    Number(autoForm.intervalEvery) !== saved.intervalEvery ||
    autoForm.intervalUnit !== saved.intervalUnit ||
    Number(autoForm.maxFiles) !== saved.maxFiles
  );
});

function applyAutoView(view: AutoBackupView, syncForm = true): void {
  autoView.value = view;
  if (!syncForm) return;
  autoForm.enabled = view.config.enabled;
  autoForm.time = view.config.time;
  autoForm.intervalEvery = view.config.intervalEvery;
  autoForm.intervalUnit = view.config.intervalUnit;
  autoForm.maxFiles = view.config.maxFiles;
}

async function loadAutoBackup(syncForm = true): Promise<void> {
  if (!props.diskAutoBackup) return;
  autoLoading.value = true;
  try {
    applyAutoView(await api.getAutoBackup(), syncForm);
  } catch (error) {
    notifyError(error, '加载自动备份配置失败');
  } finally {
    autoLoading.value = false;
  }
}

onMounted(() => {
  if (props.diskAutoBackup) {
    void loadAutoBackup(true);
  }
});

watch(
  () => props.diskAutoBackup,
  (enabled) => {
    if (enabled) void loadAutoBackup(true);
  },
);

watch(
  () => settings.globalTimezone,
  (tz, prev) => {
    if (prev && tz !== prev && autoView.value && autoView.value.timezone !== tz) {
      void loadAutoBackup(!autoDirty.value);
    }
  },
);

defineExpose({
  reload: () => loadAutoBackup(!autoDirty.value),
});

async function saveAutoBackup(): Promise<void> {
  const time = String(autoForm.time ?? '').trim();
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
    notifyError('请填写有效的备份时间（HH:mm）');
    return;
  }
  const every = Number(autoForm.intervalEvery);
  const maxInterval = autoForm.intervalUnit === 'hour' ? 720 : 365;
  if (!Number.isInteger(every) || every < 1 || every > maxInterval) {
    notifyError(`循环间隔需为 1 到 ${maxInterval} 的整数`);
    return;
  }
  const maxFiles = Number(autoForm.maxFiles);
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100) {
    notifyError('最多保留份数需为 1 到 100 的整数');
    return;
  }

  autoSaving.value = true;
  try {
    const view = await api.updateAutoBackup({
      enabled: autoForm.enabled,
      time,
      intervalEvery: every,
      intervalUnit: autoForm.intervalUnit,
      maxFiles,
    });
    applyAutoView(view, true);
    notifySuccess(view.config.enabled ? '自动备份配置已保存并启用' : '自动备份配置已保存');
  } catch (error) {
    notifyError(error, '保存自动备份配置失败');
  } finally {
    autoSaving.value = false;
  }
}

async function triggerAutoBackupNow(): Promise<void> {
  autoRunning.value = true;
  try {
    const res = await api.runAutoBackupNow();
    applyAutoView(res.view, false);
    notifySuccess(`已备份至 data 目录：${res.file.name}`);
  } catch (error) {
    notifyError(error, '立即备份失败');
  } finally {
    autoRunning.value = false;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function downloadAutoFile(file: AutoBackupFileInfo): Promise<void> {
  busyFileName.value = file.name;
  try {
    const { name, backup } = await api.readAutoBackupFile(file.name);
    saveTextFile(serializePlainBackup(backup), name);
  } catch (error) {
    notifyError(error, '下载备份文件失败');
  } finally {
    busyFileName.value = null;
  }
}

async function previewAutoFile(file: AutoBackupFileInfo): Promise<void> {
  busyFileName.value = file.name;
  previewing.value = true;
  selectedFile.value = null;
  previewSourceName.value = null;
  parsedBackup.value = null;
  preview.value = null;
  restoreAdminPassword.value = '';
  try {
    const { backup } = await api.readAutoBackupFile(file.name);
    const summary = await api.previewBackup(backup);
    parsedBackup.value = backup;
    preview.value = summary;
    previewSourceName.value = file.name;
    notifySuccess(`已载入 ${file.name} 至右侧恢复预览`);
  } catch (error) {
    notifyError(error, '载入备份预览失败');
  } finally {
    busyFileName.value = null;
    previewing.value = false;
  }
}

async function deleteAutoFile(file: AutoBackupFileInfo): Promise<void> {
  const ok = await confirmDialog({
    title: '删除自动备份',
    message: `确定删除备份文件 ${file.name} 吗？`,
    okLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  busyFileName.value = file.name;
  try {
    const files = await api.deleteAutoBackupFile(file.name);
    if (autoView.value) {
      autoView.value = { ...autoView.value, files };
    }
    notifySuccess('已删除备份文件');
  } catch (error) {
    notifyError(error, '删除备份文件失败');
  } finally {
    busyFileName.value = null;
  }
}

// ---------- 导入恢复（明文 JSON 全量备份） ----------
const selectedFile = ref<File | null>(null);
const previewSourceName = ref<string | null>(null);
const parsedBackup = ref<unknown>(null);
const preview = ref<BackupPreview | null>(null);
const previewing = ref(false);
const restoreAdminPassword = ref('');
const restoring = ref(false);

async function onFileSelected(file: File | null): Promise<void> {
  selectedFile.value = file;
  previewSourceName.value = null;
  parsedBackup.value = null;
  preview.value = null;
  restoreAdminPassword.value = '';
  if (!file) return;

  previewing.value = true;
  try {
    const text = await file.text();
    const data = parsePlainBackupFile(text);
    const summary = await api.previewBackup(data);
    parsedBackup.value = data;
    preview.value = summary;
  } catch (error) {
    notifyError(error, '解析或校验备份文件失败');
  } finally {
    previewing.value = false;
  }
}

async function runRestore(): Promise<void> {
  if (!parsedBackup.value || !preview.value) return;
  if (!restoreAdminPassword.value) {
    notifyError('请输入管理密码');
    return;
  }
  const ok = await confirmDialog({
    title: '确认覆盖恢复',
    message: `即将使用该备份覆盖当前全部提醒（${preview.value.reminders} 条）、通知渠道（${preview.value.channels} 个）与全局时区。恢复后所有提醒默认暂停，确定继续吗？`,
    okLabel: '确认覆盖',
    danger: true,
  });
  if (!ok) return;
  restoring.value = true;
  try {
    await api.restoreBackup(parsedBackup.value, restoreAdminPassword.value);
    selectedFile.value = null;
    previewSourceName.value = null;
    parsedBackup.value = null;
    preview.value = null;
    restoreAdminPassword.value = '';
    emit('restored');
    notifySuccess('覆盖恢复完成，所有提醒已默认暂停');
  } catch (error) {
    notifyError(error, '覆盖恢复失败');
  } finally {
    restoring.value = false;
  }
}
</script>

<template>
  <div class="backup-grid">
    <!-- 备份与自动备份 -->
    <div class="app-card q-pa-md">
      <div class="card-head">
        <q-icon :name="icons.backup" size="20px" color="primary" />
        <div class="col">
          <h3 class="section-title">{{ props.diskAutoBackup ? '数据备份与自动备份' : '导出全量业务备份' }}</h3>
          <div v-if="props.diskAutoBackup" class="text-muted text-caption">
            仅备份提醒事项、通知渠道配置与全局时区（明文 JSON，不含发送日志与登录密码），保存在
            <code>{{ autoView?.backupDir || '/data/backups' }}</code>，按全局时区（{{ autoView?.timezone || 'UTC' }}）执行。
          </div>
          <div v-else class="text-muted text-caption">
            导出提醒事项、通知渠道配置与全局时区（明文 JSON，可与 Docker 自部署版互通）。Cloudflare D1 同时自带 Time Travel 时间点恢复能力。
          </div>
        </div>
        <q-toggle v-if="props.diskAutoBackup" v-model="autoForm.enabled" color="primary" :disable="autoLoading || autoSaving" />
      </div>

      <!-- Cloudflare 模式或通用手动导出下载 -->
      <div v-if="!props.diskAutoBackup" class="form-stack q-mt-md">
        <q-input
          v-model="exportAdminPassword"
          type="password"
          outlined
          dense
          autocomplete="current-password"
          label="管理密码"
          placeholder="输入管理密码验证后下载 JSON 备份"
          :disable="exporting"
          @keydown.enter.prevent="runManualExport"
        />
        <div>
          <q-btn
            unelevated
            no-caps
            color="primary"
            class="touch-44"
            :icon="icons.download"
            label="导出并下载备份（JSON）"
            :loading="exporting"
            @click="runManualExport"
          />
        </div>
      </div>

      <div v-if="props.diskAutoBackup" class="sub-block q-mt-md">
        <div class="auto-grid">
          <q-input
            v-model="autoForm.time"
            type="time"
            outlined
            dense
            label="备份时间"
            class="auto-field auto-field--time"
            :disable="autoLoading || autoSaving"
          />

          <div class="interval-group auto-field auto-field--interval">
            <q-input
              v-model.number="autoForm.intervalEvery"
              type="number"
              outlined
              dense
              :min="1"
              :max="autoForm.intervalUnit === 'hour' ? 720 : 365"
              label="循环间隔"
              class="interval-num"
              :disable="autoLoading || autoSaving"
            />
            <q-select
              v-model="autoForm.intervalUnit"
              :options="intervalUnitOptions"
              option-label="label"
              option-value="value"
              emit-value
              map-options
              outlined
              dense
              class="unit-select"
              :disable="autoLoading || autoSaving"
            />
          </div>

          <q-input
            v-model.number="autoForm.maxFiles"
            type="number"
            outlined
            dense
            :min="1"
            :max="100"
            label="最多保留（份）"
            class="auto-field auto-field--max"
            :disable="autoLoading || autoSaving"
          />
        </div>

        <div v-if="autoView" class="auto-meta text-caption text-muted">
          <span v-if="autoView.state.nextRunAt">下次备份：{{ formatInstant(autoView.state.nextRunAt) }}</span>
          <span v-else>自动备份未启用</span>
          <span v-if="autoView.state.lastRunAt">最近备份：{{ formatInstant(autoView.state.lastRunAt) }}</span>
          <span v-if="autoView.state.lastError" class="text-negative">上次失败：{{ autoView.state.lastError }}</span>
        </div>

        <div class="auto-actions">
          <q-btn
            unelevated
            no-caps
            color="primary"
            class="touch-44"
            label="保存自动备份配置"
            :loading="autoSaving"
            :disable="autoLoading"
            @click="saveAutoBackup"
          />
          <q-btn
            outline
            no-caps
            color="primary"
            class="touch-44"
            :icon="icons.backup"
            label="立即备份到目录"
            :loading="autoRunning"
            :disable="autoLoading"
            @click="triggerAutoBackupNow"
          />
          <span v-if="autoDirty" class="unsaved-hint text-caption text-warning">有未保存的更改</span>
        </div>

        <!-- 本地自动备份文件列表 -->
        <div v-if="autoView?.files.length" class="file-list-wrap">
          <div class="file-list-head text-caption text-muted">
            已保存的自动备份（{{ autoView.files.length }} / {{ autoView.config.maxFiles }} 份）
          </div>
          <div class="file-list">
            <div v-for="file in autoView.files" :key="file.name" class="file-row">
              <div class="file-info">
                <div class="file-name">{{ file.name }}</div>
                <div class="file-sub text-faint">
                  {{ formatFileSize(file.sizeBytes) }} · {{ formatInstant(file.createdAt) }}
                </div>
              </div>
              <div class="file-btns">
                <q-btn
                  flat
                  round
                  dense
                  size="sm"
                  color="primary"
                  :icon="icons.download"
                  :loading="busyFileName === file.name"
                  aria-label="下载"
                  @click="downloadAutoFile(file)"
                >
                  <q-tooltip>下载文件</q-tooltip>
                </q-btn>
                <q-btn
                  flat
                  round
                  dense
                  size="sm"
                  color="warning"
                  :icon="icons.upload"
                  :disable="busyFileName === file.name || previewing"
                  aria-label="载入恢复预览"
                  @click="previewAutoFile(file)"
                >
                  <q-tooltip>载入到右侧恢复预览</q-tooltip>
                </q-btn>
                <q-btn
                  flat
                  round
                  dense
                  size="sm"
                  color="negative"
                  :icon="icons.delete"
                  :disable="busyFileName === file.name"
                  aria-label="删除"
                  @click="deleteAutoFile(file)"
                >
                  <q-tooltip>删除</q-tooltip>
                </q-btn>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 恢复 -->
    <div class="app-card q-pa-md">
      <div class="card-head">
        <q-icon :name="icons.upload" size="20px" color="warning" />
        <div>
          <h3 class="section-title">导入并覆盖恢复</h3>
          <div class="text-muted text-caption">选择明文 JSON 备份文件或从左侧自动备份一键载入即可预览恢复。恢复后所有提醒默认暂停。</div>
        </div>
      </div>

      <div class="form-stack q-mt-md">
        <q-file
          :model-value="selectedFile"
          outlined
          dense
          accept=".json,application/json"
          label="选择备份文件（.json）"
          :loading="previewing"
          :disable="previewing || restoring"
          @update:model-value="onFileSelected"
        />

        <div v-if="preview" class="preview-box">
          <div v-if="previewSourceName" class="preview-source text-caption text-muted q-mb-sm">
            已载入目录备份：<code>{{ previewSourceName }}</code>
          </div>
          <div class="preview-grid">
            <div><span class="text-muted">备份版本</span><strong>v{{ preview.sourceVersion }}</strong></div>
            <div><span class="text-muted">导出时间</span><strong>{{ formatInstant(preview.exportedAt) }}</strong></div>
            <div><span class="text-muted">全局时区</span><strong>{{ preview.globalTimezone }}</strong></div>
            <div><span class="text-muted">提醒总数</span><strong>{{ preview.reminders }}（未删除 {{ preview.activeReminders }}）</strong></div>
            <div><span class="text-muted">渠道总数</span><strong>{{ preview.channels }}</strong></div>
            <div v-if="preview.deliveries > 0"><span class="text-muted">发送日志</span><strong>{{ preview.deliveries }}</strong></div>
          </div>

          <q-banner v-if="preview.unsupportedChannels > 0" rounded class="q-mt-sm warn-banner">
            包含 {{ preview.unsupportedChannels }} 个当前暂不支持的渠道类型，将保留原配置并强制停用。
          </q-banner>

          <div v-if="preview.remindersWithoutUsableChannel.length" class="q-mt-sm warn-list">
            <div class="warn-list-title">
              以下 {{ preview.remindersWithoutUsableChannel.length }} 条未删除提醒没有可用的通知渠道（恢复后请改绑）：
            </div>
            <ul>
              <li v-for="item in preview.remindersWithoutUsableChannel.slice(0, 10)" :key="item.id">
                {{ item.title }}
              </li>
              <li v-if="preview.remindersWithoutUsableChannel.length > 10" class="text-muted">
                ……共 {{ preview.remindersWithoutUsableChannel.length }} 条
              </li>
            </ul>
          </div>

          <q-separator class="q-my-md" />

          <div class="form-stack">
            <q-input
              v-model="restoreAdminPassword"
              type="password"
              outlined
              dense
              autocomplete="current-password"
              label="输入当前管理密码以确认覆盖恢复 *"
              :disable="restoring"
              @keydown.enter.prevent="runRestore"
            />
            <q-btn
              unelevated
              no-caps
              color="negative"
              class="touch-44"
              label="确认覆盖恢复"
              :loading="restoring"
              :disable="!restoreAdminPassword"
              @click="runRestore"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.backup-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
  @media (max-width: 1023px) {
    grid-template-columns: 1fr;
  }
}
.card-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  code {
    font-size: 11.5px;
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--app-surface-2);
    overflow-wrap: anywhere;
  }
}
.sub-block {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.auto-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.auto-field--time {
  flex: 1 1 116px;
  min-width: 112px;
}
.auto-field--interval {
  flex: 1.5 1 176px;
  min-width: 170px;
}
.auto-field--max {
  flex: 1 1 124px;
  min-width: 120px;
}
.interval-group {
  display: flex;
  gap: 6px;
}
.interval-num {
  flex: 1 1 92px;
  min-width: 88px;
}
.unit-select {
  width: 74px;
  flex-shrink: 0;
}
.auto-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}
.auto-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.unsaved-hint {
  font-weight: 550;
}
.preview-source code {
  font-size: 11.5px;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--app-surface);
}
.file-list-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px dashed var(--app-border);
}
.file-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 184px;
  overflow-y: auto;
  padding-right: 2px;
}
.file-row {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--app-radius-sm);
  background: var(--app-surface-2);
  border: 1px solid var(--app-border);
}
.file-info {
  min-width: 0;
  flex: 1;
}
.file-name {
  font-size: 12.5px;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-sub {
  font-size: 11.5px;
}
.file-btns {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.form-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.preview-box {
  padding: 14px;
  border-radius: var(--app-radius-sm);
  border: 1px solid var(--app-border);
  background: var(--app-surface-2);
}
.preview-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
  font-size: 13px;
  > div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
}
.warn-banner {
  background: color-mix(in srgb, var(--q-warning) 15%, transparent);
  color: var(--app-text);
  font-size: 13px;
}
.warn-list {
  font-size: 13px;
  .warn-list-title {
    font-weight: 550;
    color: var(--q-warning);
  }
  ul {
    margin: 6px 0 0;
    padding-left: 18px;
  }
}
</style>
