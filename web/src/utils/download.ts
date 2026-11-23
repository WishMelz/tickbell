/**
 * 文件保存工具（兼容桌面端与 iOS 13+ Safari）：
 * 使用 <a download> + Blob URL 触发文件下载，并在用户点击同步调用栈中执行。
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
