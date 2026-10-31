(async () => {
    const started = Date.now();
    while (document.getElementById('new-event').disabled) {
        if (Date.now() - started > 5000) throw new Error('Calendar did not load.');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    chrome.webview.postMessage({ kind: 'smoke-result', ok: true });
})();
