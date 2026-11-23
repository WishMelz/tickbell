import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api';

export const useSettingsStore = defineStore('settings', () => {
  const globalTimezone = ref('UTC');
  const loaded = ref(false);
  let pending: Promise<void> | null = null;

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

  async function saveTimezone(timezone: string): Promise<void> {
    const settings = await api.updateSettings(timezone);
    globalTimezone.value = settings.globalTimezone;
    loaded.value = true;
  }

  function reset(): void {
    loaded.value = false;
  }

  return { globalTimezone, loaded, load, saveTimezone, reset };
});
