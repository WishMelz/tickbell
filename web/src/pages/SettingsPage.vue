<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, type SystemStatus } from '@/api';
import TimezoneSelect from '@/components/TimezoneSelect.vue';
import BackupSection from '@/components/settings/BackupSection.vue';
import ProxySection from '@/components/settings/ProxySection.vue';
import { confirmDialog } from '@/composables/dialogs';
import { notifyError, notifySuccess, useResponsive } from '@/composables/useResponsive';
import { icons } from '@/icons';
import { useAuthStore } from '@/stores/auth';
import { useSettingsStore } from '@/stores/settings';
import { type ThemeMode, useThemeStore } from '@/stores/theme';
import { chipClass } from '@/utils/status';
import { formatDuration, formatInstant } from '@/utils/time';

const router = useRouter();
const { isMobile } = useResponsive();
const auth = useAuthStore();
const settings = useSettingsStore();
const theme = useThemeStore();

const selectedTimezone = ref<string | null>(settings.globalTimezone);
const savingTz = ref(false);
const sysStatus = ref<SystemStatus | null>(null);
const loadingStatus = ref(false);
const proxySectionRef = ref<InstanceType<typeof ProxySection> | null>(null);
const backupSectionRef = ref<InstanceType<typeof BackupSection> | null>(null);

const currentPassword = ref('');
const newPassword = ref('');
const confirmNewPassword = ref('');
const changingPassword = ref(false);

const themeModes: Array<{ label: string; value: ThemeMode; icon: string }> = [
  { label: '浅色', value: 'light', icon: icons.themeLight },
  { label: '深色', value: 'dark', icon: icons.themeDark },
  { label: '跟随系统', value: 'auto', icon: icons.themeAuto },
];

async function loadAll(): Promise<void> {
  loadingStatus.value = true;
  try {
    const [, status] = await Promise.all([
      settings.load(true),
      api.systemStatus(),
      proxySectionRef.value?.reload(),
      backupSectionRef.value?.reload(),
    ]);
    selectedTimezone.value = settings.globalTimezone;
    sysStatus.value = status;
  } catch (error) {
    notifyError(error, '加载系统信息失败');
  } finally {
    loadingStatus.value = false;
  }
}

onMounted(() => {
  void loadAll();
});

async function saveTimezone(): Promise<void> {
  if (!selectedTimezone.value) return;
  savingTz.value = true;
  try {
    await settings.saveTimezone(selectedTimezone.value);
    notifySuccess('全局时区已更新');
  } catch (error) {
    notifyError(error, '保存时区失败');
  } finally {
    savingTz.value = false;
  }
}

async function handleChangePassword(): Promise<void> {
  if (!currentPassword.value) {
    notifyError('请输入当前管理密码');
    return;
  }
  if (newPassword.value.length < 6) {
    notifyError('新密码至少需要 6 个字符');
    return;
  }
  if (newPassword.value !== confirmNewPassword.value) {
    notifyError('两次输入的新密码不一致');
    return;
  }
  changingPassword.value = true;
  try {
    await api.changePassword(currentPassword.value, newPassword.value);
    currentPassword.value = '';
    newPassword.value = '';
    confirmNewPassword.value = '';
    notifySuccess('管理密码已更新，其他设备登录已失效');
  } catch (error) {
    notifyError(error, '修改密码失败');
  } finally {
    changingPassword.value = false;
  }
}

async function handleLogout(): Promise<void> {
  const ok = await confirmDialog({ title: '退出登录', message: '确定退出当前账号吗？', okLabel: '退出' });
  if (!ok) return;
  try {
    await auth.logout();
  } catch (error) {
    notifyError(error, '退出失败');
  }
  await router.replace({ name: 'login' });
}
</script>

<template>
  <q-page class="app-page">
    <div v-if="!isMobile" class="app-page-head">
      <div>
        <h1>系统设置</h1>
        <div class="sub">全局时区、外观主题、运行状态与全量备份</div>
      </div>
      <q-space />
      <q-btn flat round :icon="icons.refresh" aria-label="刷新状态" :loading="loadingStatus" @click="loadAll">
        <q-tooltip>刷新状态</q-tooltip>
      </q-btn>
    </div>

    <div class="settings-stack">
      <!-- 时区 + 主题 -->
      <div class="top-grid">
        <div class="app-card q-pa-md">
          <div class="card-head">
            <q-icon :name="icons.globe" size="20px" color="primary" />
            <div>
              <h3 class="section-title">全局时区</h3>
              <div class="text-muted text-caption">修改后，未设置独立时区的提醒会保持原本的本地日期与钟点不变。</div>
            </div>
          </div>

          <div class="tz-row q-mt-md">
            <TimezoneSelect v-model="selectedTimezone" label="全局 IANA 时区" class="col" :disabled="savingTz" />
            <q-btn
              unelevated
              no-caps
              color="primary"
              class="touch-44"
              label="保存"
              :loading="savingTz"
              :disable="!selectedTimezone || selectedTimezone === settings.globalTimezone"
              @click="saveTimezone"
            />
          </div>
        </div>

        <div class="app-card q-pa-md">
          <div class="card-head">
            <q-icon :name="icons.palette" size="20px" color="primary" />
            <div>
              <h3 class="section-title">外观主题</h3>
              <div class="text-muted text-caption">在浅色、深色或跟随系统之间切换，设置保存在当前浏览器。</div>
            </div>
          </div>

          <div class="theme-pills q-mt-md">
            <q-btn
              v-for="opt in themeModes"
              :key="opt.value"
              :unelevated="theme.mode === opt.value"
              :outline="theme.mode !== opt.value"
              no-caps
              :color="theme.mode === opt.value ? 'primary' : 'grey-7'"
              class="touch-44 col"
              :icon="opt.icon"
              :label="opt.label"
              @click="theme.setMode(opt.value)"
            />
          </div>
        </div>
      </div>

      <!-- 系统运行状态 -->
      <div class="app-card q-pa-md">
        <div class="card-head">
          <q-icon :name="icons.monitor" size="20px" color="primary" />
          <div class="col">
            <h3 class="section-title">服务运行状态</h3>
            <div class="text-muted text-caption">单机 NestJS + SQLite 进程健康指标与调度器心跳</div>
          </div>
          <span
            v-if="sysStatus"
            :class="chipClass(sysStatus.scheduler.enabled && !sysStatus.scheduler.paused ? 'positive' : 'warning')"
          >
            {{ sysStatus.scheduler.paused ? '调度已暂停' : sysStatus.scheduler.enabled ? '调度运行中' : '调度已关闭' }}
          </span>
        </div>

        <div v-if="sysStatus" class="status-grid q-mt-md">
          <div class="stat">
            <span class="text-muted">版本 / Node</span>
            <strong>v{{ sysStatus.version }} · {{ sysStatus.nodeVersion }}</strong>
          </div>
          <div class="stat">
            <span class="text-muted">已持续运行</span>
            <strong>{{ formatDuration(sysStatus.uptimeSeconds) }}</strong>
          </div>
          <div class="stat">
            <span class="text-muted">提醒数量</span>
            <strong>{{ sysStatus.counts.reminders }} / {{ sysStatus.limits.maxReminders }}（运行中 {{ sysStatus.counts.activeReminders }}）</strong>
          </div>
          <div class="stat">
            <span class="text-muted">渠道 / 待重试</span>
            <strong>{{ sysStatus.counts.channels }} 个渠道 · {{ sysStatus.counts.retryingDeliveries }} 条重试</strong>
          </div>
          <div class="stat">
            <span class="text-muted">最近一次扫描</span>
            <strong>
              {{ sysStatus.scheduler.lastTickAt ? formatInstant(sysStatus.scheduler.lastTickAt) : '尚未执行' }}
              <span v-if="sysStatus.scheduler.lastTickDurationMs !== null" class="text-caption text-muted">
                （{{ sysStatus.scheduler.lastTickDurationMs }}ms）
              </span>
            </strong>
          </div>
          <div class="stat">
            <span class="text-muted">最近 SQLite 自动备份</span>
            <strong>{{ sysStatus.backup.lastBackupAt ? formatInstant(sysStatus.backup.lastBackupAt) : '暂无记录' }}</strong>
          </div>
        </div>
      </div>

      <!-- 修改管理密码 -->
      <div class="app-card q-pa-md">
        <div class="card-head">
          <q-icon :name="icons.lock" size="20px" color="primary" />
          <div>
            <h3 class="section-title">修改管理密码</h3>
            <div class="text-muted text-caption">密码以加盐哈希保存在本地数据库，修改后其他设备的登录会自动失效。</div>
          </div>
        </div>
        <div class="pwd-row q-mt-md">
          <q-input v-model="currentPassword" type="password" outlined dense autocomplete="current-password" label="当前密码" class="pwd-input" :disable="changingPassword" />
          <q-input v-model="newPassword" type="password" outlined dense autocomplete="new-password" label="新密码（至少 6 位）" class="pwd-input" :disable="changingPassword" />
          <q-input v-model="confirmNewPassword" type="password" outlined dense autocomplete="new-password" label="确认新密码" class="pwd-input" :disable="changingPassword" />
          <q-btn unelevated no-caps color="primary" class="touch-44" label="更新密码" :loading="changingPassword" @click="handleChangePassword" />
        </div>
      </div>

      <!-- 网络代理 -->
      <ProxySection ref="proxySectionRef" />

      <!-- 备份与恢复 -->
      <BackupSection ref="backupSectionRef" />

      <!-- 移动端退出登录按钮 -->
      <div v-if="isMobile" class="q-pt-xs">
        <q-btn outline no-caps color="negative" class="full-width touch-44" :icon="icons.logout" label="退出登录" @click="handleLogout" />
      </div>
    </div>
  </q-page>
</template>

<style scoped lang="scss">
.settings-stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.top-grid {
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
  flex-wrap: wrap;
  gap: 10px;
}
.tz-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pwd-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.pwd-input {
  flex: 1 1 180px;
  min-width: 160px;
}
.theme-pills {
  display: flex;
  gap: 8px;
}
.status-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  @media (max-width: 1023px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  @media (max-width: 540px) {
    grid-template-columns: 1fr;
  }
}
.stat {
  padding: 10px 12px;
  border-radius: var(--app-radius-sm);
  background: var(--app-surface-2);
  border: 1px solid var(--app-border);
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
</style>
