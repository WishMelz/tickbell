import { computed } from 'vue';
import { Notify, useQuasar } from 'quasar';
import { errorMessage } from '@/api';

/** 响应式断点：< 1024px（$q.screen.lt.md）使用移动端布局 */
export function useResponsive() {
  const $q = useQuasar();
  const isMobile = computed(() => $q.screen.lt.md);
  /** 600–1023px：平板 / 横屏手机，卡片排两列 */
  const isTablet = computed(() => $q.screen.sm);
  return { isMobile, isTablet, $q };
}

export function notifyError(error: unknown, fallback = '操作失败'): void {
  if (error instanceof DOMException && error.name === 'AbortError') return;
  Notify.create({ type: 'negative', message: errorMessage(error, fallback) });
}

export function notifySuccess(message: string, caption?: string): void {
  Notify.create({ type: 'positive', message, caption });
}

export function notifyWarning(message: string, caption?: string): void {
  Notify.create({ type: 'warning', message, caption });
}
