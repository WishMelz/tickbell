<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, errorMessage, type AuthStatus } from '@/api';
import ThemeToggle from '@/components/ThemeToggle.vue';
import TimezoneSelect from '@/components/TimezoneSelect.vue';
import { notifySuccess } from '@/composables/useResponsive';
import { icons } from '@/icons';
import { GITHUB_REPO_LABEL, GITHUB_REPO_URL } from '@/constants/project';
import { useAuthStore } from '@/stores/auth';
import { useSettingsStore } from '@/stores/settings';
import { browserTimezone } from '@/utils/time';

const auth = useAuthStore();
const settings = useSettingsStore();
const router = useRouter();
const route = useRoute();

const password = ref('');
const confirmPassword = ref('');
const secret = ref('');
const initialTimezone = ref<string | null>(browserTimezone());
const showPassword = ref(false);
const showSecret = ref(false);

const submitting = ref(false);
const statusLoading = ref(true);
const statusError = ref('');
const status = ref<AuthStatus | null>(null);
const formError = ref('');
const lockedSeconds = ref(0);
let lockTimer: ReturnType<typeof setInterval> | null = null;

const needsSetup = computed(() => Boolean(status.value && !status.value.initialized));
const canSubmit = computed(() => !submitting.value && !statusLoading.value && !statusError.value && lockedSeconds.value === 0);

function redirectTarget(): string {
  const redirect = route.query.redirect;
  return typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/reminders';
}

function generateSecret(): void {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  secret.value = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  showSecret.value = true;
  formError.value = '';
}

async function copySecret(): Promise<void> {
  if (!secret.value) return;
  try {
    await navigator.clipboard.writeText(secret.value);
    notifySuccess('已复制密钥到剪贴板');
  } catch {
    // 剪贴板权限受限时忽略，用户可手动选中复制
  }
}

async function loadStatus(): Promise<void> {
  statusLoading.value = true;
  statusError.value = '';
  try {
    status.value = await auth.ensureStatus(true);
    if (status.value.authenticated) {
      await router.replace(redirectTarget());
      return;
    }
    if (!status.value.initialized && !secret.value) {
      generateSecret();
      showSecret.value = false;
    }
  } catch {
    statusError.value = '无法连接服务器，请检查网络或确认后端服务已启动。';
  } finally {
    statusLoading.value = false;
  }
}

function startLock(seconds: number): void {
  lockedSeconds.value = seconds;
  if (lockTimer) clearInterval(lockTimer);
  lockTimer = setInterval(() => {
    lockedSeconds.value -= 1;
    if (lockedSeconds.value <= 0) {
      lockedSeconds.value = 0;
      if (lockTimer) clearInterval(lockTimer);
      lockTimer = null;
    }
  }, 1000);
}

async function submitSetup(): Promise<void> {
  if (!canSubmit.value) return;
  formError.value = '';

  if (password.value.length < 6) {
    formError.value = '管理密码至少需要 6 个字符';
    return;
  }
  if (password.value !== confirmPassword.value) {
    formError.value = '两次输入的管理密码不一致';
    return;
  }
  const trimmedSecret = secret.value.trim();
  if (trimmedSecret.length < 16) {
    formError.value = '系统密钥至少需要 16 个字符（可点击右侧随机生成）';
    return;
  }

  submitting.value = true;
  try {
    await auth.setup({
      password: password.value,
      secret: trimmedSecret,
      globalTimezone: initialTimezone.value ?? undefined,
    });
    password.value = '';
    confirmPassword.value = '';
    secret.value = '';
    settings.reset();
    notifySuccess('初始化完成，后续重启无需再配置环境变量');
    await router.replace(redirectTarget());
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) {
      startLock(error.retryAfter ?? 60);
      formError.value = '尝试次数过多，请稍后再试';
    } else if (error instanceof ApiError && error.status === 409) {
      await loadStatus();
      formError.value = '系统已完成初始化，请直接输入密码登录';
    } else {
      formError.value = errorMessage(error, '初始化失败');
    }
  } finally {
    submitting.value = false;
  }
}

async function submitLogin(): Promise<void> {
  if (!canSubmit.value) return;
  formError.value = '';
  if (!password.value) {
    formError.value = '请输入管理密码';
    return;
  }
  submitting.value = true;
  try {
    await auth.login(password.value);
    password.value = '';
    settings.reset();
    await router.replace(redirectTarget());
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) {
      startLock(error.retryAfter ?? 60);
      formError.value = '尝试次数过多，请稍后再试';
    } else if (error instanceof ApiError && error.status === 401) {
      formError.value = '密码不正确';
    } else {
      formError.value = errorMessage(error, '登录失败');
    }
  } finally {
    submitting.value = false;
  }
}

onMounted(loadStatus);
onBeforeUnmount(() => {
  if (lockTimer) clearInterval(lockTimer);
});
</script>

<template>
  <div class="login-page">
    <div class="login-theme"><ThemeToggle /></div>
    <main class="login-card app-card" :class="{ 'login-card--setup': needsSetup }">
      <div class="login-mark"><q-icon :name="icons.notificationsActive" size="30px" /></div>
      <h1>{{ needsSetup ? '首次启动初始化' : 'TickBell' }}</h1>
      <p class="text-muted login-sub">
        {{ needsSetup ? '手动设置管理密码与系统密钥，持久化到数据库后无需再配置环境变量' : '请输入管理密码登录' }}
      </p>

      <div v-if="statusLoading" class="row justify-center q-py-lg"><q-spinner size="32px" color="primary" /></div>

      <template v-else>
        <q-banner v-if="statusError" rounded class="login-banner login-banner--error">
          <template #avatar><q-icon :name="icons.error" color="negative" /></template>
          {{ statusError }}
          <template #action><q-btn flat no-caps color="primary" label="重试" @click="loadStatus" /></template>
        </q-banner>

        <!-- 首次初始化表单 -->
        <form v-else-if="needsSetup" class="login-form" novalidate @submit.prevent="submitSetup">
          <q-input
            v-model="password"
            outlined
            dense
            :type="showPassword ? 'text' : 'password'"
            label="管理密码（至少 6 位）*"
            autocomplete="new-password"
            autofocus
            @update:model-value="formError = ''"
          >
            <template #prepend><q-icon :name="icons.lock" /></template>
            <template #append>
              <q-btn
                flat
                round
                dense
                class="touch-44"
                :icon="showPassword ? icons.visibilityOff : icons.visibility"
                aria-label="切换显示密码"
                @click="showPassword = !showPassword"
              />
            </template>
          </q-input>

          <q-input
            v-model="confirmPassword"
            outlined
            dense
            :type="showPassword ? 'text' : 'password'"
            label="确认管理密码 *"
            autocomplete="new-password"
            @update:model-value="formError = ''"
          >
            <template #prepend><q-icon :name="icons.lock" /></template>
          </q-input>

          <q-input
            v-model="secret"
            outlined
            dense
            :type="showSecret ? 'text' : 'password'"
            label="系统密钥（至少 16 位，用于会话签名）*"
            hint="可自定义输入，或点击右侧随机生成；保存后持久化存放在数据库中"
            autocomplete="off"
            @update:model-value="formError = ''"
          >
            <template #prepend><q-icon :name="icons.key" /></template>
            <template #append>
              <q-btn flat round dense :icon="showSecret ? icons.visibilityOff : icons.visibility" aria-label="显示密钥" @click="showSecret = !showSecret" />
              <q-btn flat round dense :icon="icons.refresh" aria-label="随机生成密钥" @click="generateSecret">
                <q-tooltip>随机生成</q-tooltip>
              </q-btn>
              <q-btn v-if="secret" flat round dense :icon="icons.copy" aria-label="复制密钥" @click="copySecret">
                <q-tooltip>复制密钥</q-tooltip>
              </q-btn>
            </template>
          </q-input>

          <TimezoneSelect v-model="initialTimezone" label="默认全局时区" />

          <div v-if="formError" class="form-err text-negative">{{ formError }}</div>

          <q-btn
            type="submit"
            unelevated
            no-caps
            color="primary"
            size="lg"
            class="full-width login-btn q-mt-xs"
            :loading="submitting"
            :disable="!canSubmit"
            :label="lockedSeconds > 0 ? `请 ${lockedSeconds} 秒后再试` : '完成初始化并进入系统'"
          />
        </form>

        <!-- 日常登录表单 -->
        <form v-else class="login-form" novalidate @submit.prevent="submitLogin">
          <input type="text" name="username" autocomplete="username" value="admin" hidden aria-hidden="true" />
          <q-input
            v-model="password"
            outlined
            :type="showPassword ? 'text' : 'password'"
            label="管理密码"
            autocomplete="current-password"
            autofocus
            :error="!!formError"
            :error-message="formError"
            @update:model-value="formError = ''"
          >
            <template #prepend><q-icon :name="icons.lock" /></template>
            <template #append>
              <q-btn
                flat
                round
                dense
                class="touch-44"
                :icon="showPassword ? icons.visibilityOff : icons.visibility"
                :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                @click="showPassword = !showPassword"
              />
            </template>
          </q-input>
          <q-btn
            type="submit"
            unelevated
            no-caps
            color="primary"
            size="lg"
            class="full-width login-btn"
            :loading="submitting"
            :disable="!canSubmit"
            :label="lockedSeconds > 0 ? `请 ${lockedSeconds} 秒后再试` : '登录'"
          />
        </form>
      </template>
    </main>
    <p class="login-foot text-faint">
      <span>TickBell · 轻量多渠道提醒服务</span>
      <span aria-hidden="true">·</span>
      <a
        class="foot-github"
        :href="GITHUB_REPO_URL"
        target="_blank"
        rel="noopener noreferrer"
      >
        <q-icon :name="icons.github" size="14px" />
        <span>{{ GITHUB_REPO_LABEL }}</span>
      </a>
    </p>
  </div>
</template>

<style scoped lang="scss">
.login-page {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: calc(24px + var(--safe-top)) calc(16px + var(--safe-right)) calc(24px + var(--safe-bottom)) calc(16px + var(--safe-left));
  background:
    radial-gradient(1200px 500px at 50% -10%, color-mix(in srgb, var(--q-primary) 16%, transparent), transparent 70%),
    var(--app-bg);
}
.login-theme {
  position: fixed;
  top: calc(8px + var(--safe-top));
  right: calc(8px + var(--safe-right));
}
.login-card {
  width: 100%;
  max-width: 400px;
  padding: 36px 28px 28px;
  text-align: center;
  h1 {
    margin: 14px 0 4px;
    font-size: 24px;
    font-weight: 700;
    line-height: 1.3;
  }
}
.login-card--setup {
  max-width: 460px;
}
.login-sub {
  margin: 0 0 22px;
  font-size: 13.5px;
  line-height: 1.5;
}
.login-mark {
  width: 60px;
  height: 60px;
  margin: 0 auto;
  border-radius: 18px;
  display: grid;
  place-items: center;
  color: #fff;
  background: linear-gradient(135deg, var(--q-primary), color-mix(in srgb, var(--q-primary) 60%, var(--q-accent)));
  box-shadow: 0 8px 24px color-mix(in srgb, var(--q-primary) 35%, transparent);
}
.login-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  text-align: left;
}
.form-err {
  font-size: 13px;
}
.login-btn {
  min-height: 48px;
  border-radius: 12px;
}
.login-banner {
  text-align: left;
  margin-bottom: 16px;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--app-text);
}
.login-banner--error {
  background: color-mix(in srgb, var(--q-negative) 12%, transparent);
}
.login-foot {
  margin-top: 20px;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 6px;
}
.foot-github {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: inherit;
  text-decoration: none;
  transition: color 0.15s ease;
  &:hover {
    color: var(--q-primary);
  }
}
@media (max-width: 480px) {
  .login-card {
    padding: 28px 18px 22px;
  }
}
</style>
