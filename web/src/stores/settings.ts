import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, type RuntimeCapabilities, type RuntimeKind, type SystemStatus } from '@/api';

const DEFAULT_CAPABILITIES: RuntimeCapabilities = {
  proxies: true,
  diskAutoBackup: true,
  sqliteVacuumBackup: true,
  minScheduleIntervalSec: 15,
  allowPrivateUrls: true,
};

export const useSettingsStore = defineStore('settings', () => {
  const globalTimezone = ref('UTC');
  const loaded = ref(false);
  const runtime = ref<RuntimeKind>('node');
  const capabilities = ref<RuntimeCapabilities>({ ...DEFAULT_CAPABILITIES });
  const capabilitiesLoaded = ref(false);
  let pending: Promise<void> | null = null;
  let pendingCap: Promise<void> | null = null;

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return;
    if (!pending) {
      pending = api
        .getSettings()
        .then((settings) => {
          globalTimezone.value = settings.globalTimezone;
          loaded.value = true;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  }

  function setSystemStatus(status: SystemStatus): void {
    if (status.runtime) runtime.value = status.runtime;
    if (status.capabilities) {
      capabilities.value = { ...status.capabilities };
      capabilitiesLoaded.value = true;
    }
  }

  async function loadCapabilities(force = false): Promise<void> {
    if (capabilitiesLoaded.value && !force) return;
    if (!pendingCap) {
      pendingCap = api
        .systemStatus()
        .then((status) => {
          setSystemStatus(status);
        })
        .catch(() => {
          // fall back to defaults silently
        })
        .finally(() => {
          pendingCap = null;
        });
    }
    return pendingCap;
  }

  async function saveTimezone(timezone: string): Promise<void> {
    const settings = await api.updateSettings(timezone);
    globalTimezone.value = settings.globalTimezone;
    loaded.value = true;
  }

  function reset(): void {
    loaded.value = false;
    capabilitiesLoaded.value = false;
  }

  return {
    globalTimezone,
    loaded,
    runtime,
    capabilities,
    capabilitiesLoaded,
    load,
    loadCapabilities,
    setSystemStatus,
    saveTimezone,
    reset,
  };
});
