/**
 * 文件保存工具，兼顾 iOS Safari：
 * - 优先用 <a download> + Blob URL（iOS 13+ Safari 会弹出“下载”确认，保存到“文件”App）。
 * - 支持 Web Share（含文件）的设备额外提供“分享 / 存储到文件”。
 * 两个动作都必须在用户点击的同步调用栈中触发，所以由界面上的按钮直接调用，而不是在异步加密完成后自动触发。
 */

export function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

export function saveTextFile(text: string, filename: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // iOS 需要较长时间才会开始读取 Blob，延迟释放
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function canShareFile(text: string, filename: string, mime = 'application/json'): boolean {
  try {
    if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
    const file = new File([text], filename, { type: mime });
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export async function shareTextFile(text: string, filename: string, mime = 'application/json'): Promise<void> {
  const file = new File([text], filename, { type: mime });
  await navigator.share({ files: [file], title: filename });
}
