<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, type BackupPreview } from '@/api';
import { notifyError, notifySuccess } from '@/composables/useResponsive';
import { icons } from '@/icons';
import { useAuthStore } from '@/stores/auth';
import { canShareFile, isIOS, saveTextFile, shareTextFile } from '@/utils/download';
import {
  backupFileName,
  decryptFullBackup,
  inspectBackupFile,
  serializePlainBackup,
} from '@/utils/fullBackup';
import { formatInstant } from '@/utils/time';

const router = useRouter();
const auth = useAuthStore();

// ---------- 导出（明文 JSON） ----------
const exportAdminPassword = ref('');
const exporting = ref(false);
const readyExport = ref<{ text: string; filename: string; canShare: boolean } | null>(null);

async function runExport(): Promise<void> {
  if (!exportAdminPassword.value) {
    notifyError('请输入管理密码');
    return;
  }
  exporting.value = true;
  readyExport.value = null;
  try {
    const raw = await api.exportBackup(exportAdminPassword.value);
    const text = serializePlainBackup(raw);
    const filename = backupFileName();
    readyExport.value = { text, filename, canShare: canShareFile(text, filename) };
    exportAdminPassword.value = '';
    if (!isIOS()) {
      saveTextFile(text, filename);
      notifySuccess('明文全量备份已导出并开始下载');
    } else {
      notifySuccess('明文全量备份已生成，请点击下方按钮保存文件');
    }
  } catch (error) {
    notifyError(error, '导出备份失败');
  } finally {
    exporting.value = false;
  }
}

function triggerDownload(): void {
  if (!readyExport.value) return;
  saveTextFile(readyExport.value.text, readyExport.value.filename);
}

async function triggerShare(): Promise<void> {
  if (!readyExport.value) return;
  try {
    await shareTextFile(readyExport.value.text, readyExport.value.filename);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    notifyError(error, '系统分享失败，请点击下载按钮保存');
  }
}

// ---------- 导入恢复（支持明文备份，同时兼容旧版 Tips 加密备份） ----------
const selectedFile = ref<File | null>(null);
const selectedFileText = ref('');
const isLegacyEncrypted = ref(false);
const restoreBackupPassword = ref('');
const parsedBackup = ref<unknown>(null);
const preview = ref<BackupPreview | null>(null);
const previewing = ref(false);
const restoreAdminPassword = ref('');
const confirmWord = ref('');
const restoring = ref(false);

async function onFileSelected(file: File | null): Promise<void> {
  selectedFile.value = file;
  selectedFileText.value = '';
  isLegacyEncrypted.value = false;
  restoreBackupPassword.value = '';
  parsedBackup.value = null;
  preview.value = null;
  confirmWord.value = '';
  if (!file) return;

  previewing.value = true;
  try {
    const text = await file.text();
    selectedFileText.value = text;
    const inspected = inspectBackupFile(text);
    if (inspected.kind === 'encrypted') {
      isLegacyEncrypted.value = true;
      return;
    }
    const summary = await api.previewBackup(inspected.data);
    parsedBackup.value = inspected.data;
    preview.value = summary;
  } catch (error) {
    notifyError(error, '解析或校验备份文件失败');
  } finally {
    previewing.value = false;
  }
}

async function runDecryptPreview(): Promise<void> {
  if (!selectedFileText.value) {
    notifyError('请先选择备份文件');
    return;
  }
  if (!restoreBackupPassword.value) {
    notifyError('请输入旧版备份密码');
    return;
  }
  previewing.value = true;
  preview.value = null;
  parsedBackup.value = null;
  try {
    const parsed = await decryptFullBackup(selectedFileText.value, restoreBackupPassword.value);
    const summary = await api.previewBackup(parsed);
    parsedBackup.value = parsed;
    preview.value = summary;
  } catch (error) {
    notifyError(error, '解密或校验备份失败');
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
  if (confirmWord.value.trim() !== 'RESTORE') {
    notifyError('请输入 RESTORE 确认覆盖恢复');
    return;
  }
  restoring.value = true;
  try {
    await api.restoreBackup(parsedBackup.value, restoreAdminPassword.value, 'RESTORE');
    notifySuccess('全量恢复完成，请重新登录');
    auth.clear();
    await router.replace({ name: 'login' });
  } catch (error) {
    notifyError(error, '覆盖恢复失败');
  } finally {
    restoring.value = false;
  }
}
</script>

<template>
  <div class="backup-grid">
    <!-- 导出 -->
    <div class="app-card q-pa-md">
      <div class="card-head">
        <q-icon :name="icons.download" size="20px" color="primary" />
        <div>
          <h3 class="section-title">导出全量备份（明文 JSON）</h3>
          <div class="text-muted text-caption">导出全部提醒、渠道配置、设置与发送日志（不含登录密码），为可读明文 JSON，请妥善保存。</div>
        </div>
      </div>

      <div class="form-stack q-mt-md">
        <q-input
          v-model="exportAdminPassword"
          type="password"
          outlined
          dense
          autocomplete="current-password"
          label="当前管理密码"
          :disable="exporting"
          @keydown.enter.prevent="runExport"
        />
        <div>
          <q-btn
            unelevated
            no-caps
            color="primary"
            class="touch-44"
            :icon="icons.backup"
            label="导出明文备份"
            :loading="exporting"
            @click="runExport"
          />
        </div>

        <div v-if="readyExport" class="ready-box">
          <div class="ready-title">
            <q-icon :name="icons.checkCircle" color="positive" size="18px" />
            <span>{{ readyExport.filename }}</span>
          </div>
          <div class="ready-actions">
            <q-btn unelevated no-caps color="positive" class="touch-44" :icon="icons.download" label="再次下载" @click="triggerDownload" />
            <q-btn
              v-if="readyExport.canShare"
              outline
              no-caps
              color="primary"
              class="touch-44"
              :icon="icons.share"
              label="分享 / 存到文件"
              @click="triggerShare"
            />
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
          <div class="text-muted text-caption">选择明文全量备份文件即可直接预览恢复（也自动兼容旧版 Tips 加密备份）。恢复后所有提醒默认暂停。</div>
        </div>
      </div>

      <div class="form-stack q-mt-md">
        <q-file
          :model-value="selectedFile"
          outlined
          dense
          accept=".json,application/json"
          label="选择全量备份文件（.json）"
          :loading="previewing"
          :disable="previewing || restoring"
          @update:model-value="onFileSelected"
        />

        <template v-if="isLegacyEncrypted && !preview">
          <q-banner rounded class="warn-banner">
            检测到旧版 Tips 加密备份文件，请输入当时的备份密码以解密预览。
          </q-banner>
          <q-input
            v-model="restoreBackupPassword"
            type="password"
            outlined
            dense
            autocomplete="off"
            label="旧版备份密码"
            :disable="previewing || restoring"
            @keydown.enter.prevent="runDecryptPreview"
          />
          <div>
            <q-btn
              outline
              no-caps
              color="primary"
              class="touch-44"
              label="解密并预览内容"
              :loading="previewing"
              :disable="restoring"
              @click="runDecryptPreview"
            />
          </div>
        </template>

        <div v-if="preview" class="preview-box">
          <div class="preview-grid">
            <div><span class="text-muted">备份版本</span><strong>v{{ preview.sourceVersion }}</strong></div>
            <div><span class="text-muted">导出时间</span><strong>{{ formatInstant(preview.exportedAt) }}</strong></div>
            <div><span class="text-muted">全局时区</span><strong>{{ preview.globalTimezone }}</strong></div>
            <div><span class="text-muted">提醒总数</span><strong>{{ preview.reminders }}（未删除 {{ preview.activeReminders }}）</strong></div>
            <div><span class="text-muted">渠道总数</span><strong>{{ preview.channels }}</strong></div>
            <div><span class="text-muted">发送日志</span><strong>{{ preview.deliveries }}</strong></div>
          </div>

          <q-banner
            v-if="
              Array.isArray(preview.unsupportedChannels)
                ? preview.unsupportedChannels.length > 0
                : preview.unsupportedChannels > 0
            "
            rounded
            class="q-mt-sm warn-banner"
          >
            包含
            {{
              Array.isArray(preview.unsupportedChannels)
                ? preview.unsupportedChannels.length
                : preview.unsupportedChannels
            }}
            个当前暂不支持的渠道类型（例如旧版 Telegram / Webhook），将保留原配置并强制停用。
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
              label="当前管理密码 *"
              :disable="restoring"
            />
            <q-input
              v-model="confirmWord"
              outlined
              dense
              label="输入 RESTORE 确认覆盖当前全部业务数据 *"
              placeholder="RESTORE"
              :disable="restoring"
            />
            <q-btn
              unelevated
              no-caps
              color="negative"
              class="touch-44"
              label="确认覆盖恢复"
              :loading="restoring"
              :disable="confirmWord.trim() !== 'RESTORE'"
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
  @media (max-width: 1023px) {
    grid-template-columns: 1fr;
  }
}
.card-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.form-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ready-box {
  padding: 12px;
  border-radius: var(--app-radius-sm);
  border: 1px solid var(--app-border);
  background: var(--app-surface-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ready-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 550;
  word-break: break-all;
}
.ready-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
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
