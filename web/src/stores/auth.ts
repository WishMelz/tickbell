import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api, type AuthStatus } from '@/api';

export const useAuthStore = defineStore('auth', () => {
  const status = ref<AuthStatus | null>(null);
  let pending: Promise<AuthStatus> | null = null;

  const initialized = computed(() => status.value?.initialized === true);
  const authenticated = computed(() => status.value?.authenticated === true);
  const checked = computed(() => status.value !== null);

  /** 路由守卫只在首次导航时调用一次；之后由 401 处理器和初始化 / 登录 / 退出维护状态 */
  async function ensureStatus(force = false): Promise<AuthStatus> {
    if (status.value && !force) return status.value;
    if (!pending) {
      pending = api
        .authStatus()
        .then((value) => {
          status.value = value;
          return value;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  }

  async function setup(input: { password: string; secret: string; globalTimezone?: string }): Promise<void> {
    await api.setupAuth(input);
    status.value = { initialized: true, configured: true, authenticated: true, configurationIssue: null };
  }

  async function login(password: string): Promise<void> {
    await api.login(password);
    status.value = { initialized: true, configured: true, authenticated: true, configurationIssue: null };
  }

  async function logout(): Promise<void> {
    try {
      await api.logout();
    } finally {
      clear();
    }
  }

  /** 会话失效（401）或恢复备份后调用 */
  function clear(): void {
    if (status.value) status.value = { ...status.value, authenticated: false };
    else status.value = { initialized: true, configured: true, authenticated: false, configurationIssue: null };
  }

  return { status, initialized, authenticated, checked, ensureStatus, setup, login, logout, clear };
});
