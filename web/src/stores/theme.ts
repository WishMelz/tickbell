import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { Dark } from 'quasar';

export type ThemeMode = 'light' | 'dark' | 'auto';

/** 与 index.html 内联脚本保持一致：localStorage 键与两种背景色 */
export const THEME_STORAGE_KEY = 'tickbell-theme';
const BG_LIGHT = '#f4f6fa';
const BG_DARK = '#0f1218';

function readSaved(): ThemeMode {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' || value === 'auto' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'auto', label: '跟随系统' },
];

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(readSaved());
  const isDark = computed(() => Dark.isActive);
  let media: MediaQueryList | null = null;

  function syncChrome(): void {
    const dark = Dark.isActive;
    const color = dark ? BG_DARK : BG_LIGHT;
    const root = document.documentElement.style;
    root.backgroundColor = color;
    root.colorScheme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
  }

  function apply(): void {
    Dark.set(mode.value === 'auto' ? 'auto' : mode.value === 'dark');
    // Dark.set('auto') 立即生效，但为保险在下一帧再同步一次地址栏颜色
    syncChrome();
    requestAnimationFrame(syncChrome);
  }

  function setMode(value: ThemeMode): void {
    mode.value = value;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch {
      /* 隐私模式下可能无法写入 */
    }
    apply();
  }

  /** 循环切换：浅色 → 深色 → 跟随系统 */
  function cycle(): void {
    const order: ThemeMode[] = ['light', 'dark', 'auto'];
    setMode(order[(order.indexOf(mode.value) + 1) % order.length]!);
  }

  function init(): void {
    apply();
    if (!media && window.matchMedia) {
      media = window.matchMedia('(prefers-color-scheme: dark)');
      media.addEventListener('change', () => {
        if (mode.value === 'auto') requestAnimationFrame(syncChrome);
      });
    }
  }

  return { mode, isDark, setMode, cycle, init };
});
