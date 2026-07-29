import { useStudio } from '../store.js';

function reportCopySuccess(okLabel: string): void {
  useStudio.getState().pushToast('success', okLabel);
}

function reportCopyFailure(): void {
  useStudio.getState().pushToast('warning', '复制失败，请检查剪贴板权限');
}

/** Copy text and report the result through the app toast queue. */
export async function copyText(text: string, okLabel = '已复制'): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
    reportCopySuccess(okLabel);
    return true;
  } catch {
    reportCopyFailure();
    return false;
  }
}

/**
 * Start a clipboard write before deferred text is ready. WebKit can discard
 * user activation after an await, so ClipboardItem receives the promise while
 * the context-menu click is still on the stack.
 */
export async function copyTextDeferred(
  textPromise: Promise<string>,
  okLabel = '已复制',
): Promise<boolean> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      return await copyText(await textPromise, okLabel);
    }
    const blobPromise = textPromise.then(
      (text) => new Blob([text], { type: 'text/plain' }),
    );
    await navigator.clipboard.write([
      new ClipboardItem({ 'text/plain': blobPromise }),
    ]);
    reportCopySuccess(okLabel);
    return true;
  } catch {
    // clipboard.write and promise-valued ClipboardItem support varies; retry
    // through the wider writeText path before giving up. copyText reports its
    // own outcome; a rejected textPromise still lands in the outer catch.
    try {
      return await copyText(await textPromise, okLabel);
    } catch {
      reportCopyFailure();
      return false;
    }
  }
}
