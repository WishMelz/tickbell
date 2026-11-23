import { Dialog } from 'quasar';

export interface ConfirmOptions {
  title: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  html?: false;
}

/** Quasar Dialog 的 Promise 封装：确认返回 true，取消 / 关闭返回 false */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    Dialog.create({
      title: options.title,
      message: options.message,
      persistent: false,
      class: 'app-confirm-dialog',
      ok: { label: options.okLabel ?? '确定', color: options.danger ? 'negative' : 'primary', unelevated: true, noCaps: true },
      cancel: { label: options.cancelLabel ?? '取消', flat: true, color: 'grey-7', noCaps: true },
    })
      .onOk(() => resolve(true))
      .onCancel(() => resolve(false))
      .onDismiss(() => resolve(false));
  });
}

export function alertDialog(title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    Dialog.create({ title, message, ok: { label: '知道了', flat: true, color: 'primary', noCaps: true } })
      .onOk(() => resolve())
      .onDismiss(() => resolve());
  });
}
