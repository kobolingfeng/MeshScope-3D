// IPC bridge — frontend ↔ 强强 native shell
// 协议:
//   Request:  { id, cmd, args }
//   Response: { id, result } | { id, error }
//   Event:    { event, data }

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

const pending = new Map<number, Pending>();
let nextId = 0;

const webview = typeof window !== 'undefined'
    ? (window as any).chrome?.webview
    : null;
const hasWebView = Boolean(
    webview
    && typeof webview.postMessage === 'function'
    && typeof webview.addEventListener === 'function',
);

if (hasWebView) {
    webview.addEventListener('message', (e: MessageEvent) => {
        const msg = e.data;
        if (msg && typeof msg.id === 'number') {
            const p = pending.get(msg.id);
            if (p) {
                pending.delete(msg.id);
                if ('error' in msg) p.reject(new Error(msg.error));
                else p.resolve(msg.result);
            }
        }
        if (msg && typeof msg.event === 'string') {
            window.dispatchEvent(new CustomEvent(`ipc:${msg.event}`, { detail: msg.data }));
        }
    });
}

export const inNative = hasWebView;

export function invoke<T = any>(cmd: string, args: Record<string, any> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
        if (!hasWebView) {
            // 在浏览器直接打开 (vite dev without 强强 shell) 时静默失败，方便调试
            reject(new Error('Not running in WebView2'));
            return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        webview.postMessage({ id, cmd, args });
    });
}

export function on(event: string, handler: (data: any) => void): () => void {
    const listener = ((e: CustomEvent) => handler(e.detail)) as EventListener;
    window.addEventListener(`ipc:${event}`, listener);
    return () => window.removeEventListener(`ipc:${event}`, listener);
}
