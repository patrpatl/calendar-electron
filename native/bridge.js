(() => {
    if (window !== window.top || location.href !== 'https://calendar.example/index.html') return;
    const pending = new Map();
    const listeners = new Map();
    let sequence = 0;
    const send = value => window.chrome.webview.postMessage(value);
    const invoke = (channel, value) => new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        send({ kind: 'invoke', id, channel, value });
    });
    const subscribe = (name, callback) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(callback);
        return () => listeners.get(name).delete(callback);
    };
    window.chrome.webview.addEventListener('message', async ({ data }) => {
        if (data.kind === 'result') {
            const request = pending.get(data.id);
            if (request) { pending.delete(data.id); request.resolve(data.result); }
        } else if (data.kind === 'event') {
            for (const callback of listeners.get(data.name) || []) callback(data.value);
        } else if (data.kind === 'flush-editor') {
            let ok = true;
            try {
                for (const callback of listeners.get('close') || []) {
                    if (await callback() !== true) ok = false;
                }
            } catch { ok = false; }
            send({ kind: 'close-ready', requestId: data.requestId, ok });
        }
    });
    Object.defineProperties(window, {
        calendarAPI: { value: Object.freeze({
            list: () => invoke('calendar:list'),
            save: value => invoke('calendar:save', value),
            delete: id => invoke('calendar:delete', id),
            onWindowClose: callback => subscribe('close', callback)
        }) },
        settingsAPI: { value: Object.freeze({
            supportsSystemWebView: true,
            get: () => invoke('settings:get'),
            setTheme: theme => invoke('settings:set-theme', theme),
            setRuntime: runtime => invoke('settings:set-runtime', runtime),
            onChanged: callback => subscribe('settings:changed', callback)
        }) },
        driveAPI: { value: Object.freeze(Object.fromEntries([
            ['status', 'status'], ['importClient', 'import-client'], ['connect', 'connect'],
            ['cancelConnect', 'cancel-connect'], ['upload', 'upload'], ['restore', 'restore'], ['disconnect', 'disconnect']
        ].map(([method, action]) => [method, () => invoke(`drive:${action}`)]))) }
    });
    // A failed renderer must trigger fallback instead of leaving an empty window.
    window.addEventListener('error', () => send({ kind: 'renderer-error' }));
    window.addEventListener('unhandledrejection', () => send({ kind: 'renderer-error' }));
    document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.dataset.host = 'webview';
        const checkReady = () => {
            if (document.getElementById('new-event')?.disabled === false) {
                observer.disconnect();
                send({ kind: 'ready' });
            } else if (document.getElementById('app-error')?.hidden === false) {
                // A readable storage error is a working renderer, not a host failure.
                observer.disconnect();
                send({ kind: 'ready' });
            }
        };
        const observer = new MutationObserver(checkReady);
        observer.observe(document.body, { attributes: true, childList: true, subtree: true });
        send({ kind: 'document-ready' });
        checkReady();
    });
})();
