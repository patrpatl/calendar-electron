(async () => {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const wait = async predicate => {
        const start = Date.now();
        while (!predicate()) {
            if (Date.now() - start > 5000) throw new Error('Timed out waiting for WebView UI.');
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    };
    try {
        const $ = id => document.getElementById(id);
        await wait(() => !$('new-event').disabled);
        check(document.querySelectorAll('[data-date]').length === 42, 'Calendar did not render.');
        check(typeof window.require === 'undefined' && typeof window.process === 'undefined', 'Renderer has Node access.');
        check(getComputedStyle(document.querySelector('.window-titlebar')).display === 'none', 'Duplicate title bar.');
        check((await calendarAPI.list()).events.length === 0, 'Smoke profile is not isolated.');

        $('new-event').click();
        $('event-title').value = 'WebView smoke event';
        $('event-title').dispatchEvent(new Event('input', { bubbles: true }));
        $('event-form').requestSubmit();
        await wait(() => !$('event-dialog').open);
        const saved = await calendarAPI.list();
        check(saved.ok && saved.events.length === 1 && saved.events[0].title === 'WebView smoke event', 'Editor did not persist event.');
        const event = saved.events[0];
        const updated = await calendarAPI.save({ ...event, title: 'Edited in WebView' });
        check(updated.ok && updated.events[0].title === 'Edited in WebView', 'Event update failed.');
        check(!(await calendarAPI.save({ title: '' })).ok, 'Invalid event was accepted.');

        $('open-settings').click();
        await wait(() => !$('theme-options').disabled && !$('drive-import').disabled);
        check((await settingsAPI.get()).settings.theme === 'system', 'Default theme mismatch.');
        check(document.querySelector('input[name="runtime"]:checked').value === 'electron', 'Electron is not the default engine.');
        document.querySelector('input[name="runtime"][value="webview"]').click();
        await wait(() => !$('runtime-options').disabled);
        check((await settingsAPI.get()).settings.runtime === 'webview', 'System WebView preference did not save.');
        check((await settingsAPI.setTheme('dark')).ok, 'Could not save dark theme.');
        await wait(() => matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.bsTheme === 'dark');
        check((await settingsAPI.setTheme('light')).ok, 'Could not save light theme.');
        await wait(() => !matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.bsTheme === 'light');
        check(!(await settingsAPI.setTheme('invalid')).ok, 'Invalid theme was accepted.');
        check((await settingsAPI.get()).settings.runtime === 'webview', 'Theme change overwrote the engine preference.');
        check(!(await settingsAPI.setRuntime('invalid')).ok, 'Invalid engine was accepted.');
        document.querySelector('input[name="runtime"][value="electron"]').click();
        await wait(() => !$('runtime-options').disabled);
        check((await settingsAPI.get()).settings.runtime === 'electron', 'Electron preference did not save.');
        check((await driveAPI.status()).status.configured === false, 'Unexpected Drive credentials.');
        check(!(await driveAPI.connect()).ok, 'Drive connected without credentials.');
        check(!(await driveAPI.upload()).ok, 'Drive uploaded without credentials.');
        check(!(await driveAPI.restore()).ok, 'Drive restored without credentials.');
        await settingsAPI.setTheme('system');
        $('done-settings').click();

        const deleted = await calendarAPI.delete(event.id);
        check(deleted.ok && deleted.events.length === 0, 'Delete failed.');
        // Leave a real persisted record for the backend runner to verify after exit.
        check((await calendarAPI.save({ ...event, id: undefined, title: 'Persisted after WebView exit' })).ok, 'Final save failed.');
        // The close handshake must wait for pending renderer saves.
        calendarAPI.onWindowClose(async () => {
            await new Promise(resolve => setTimeout(resolve, 80));
            return (await calendarAPI.save({ ...event, id: undefined, title: 'Saved during window close' })).ok;
        });
        chrome.webview.postMessage({ kind: 'smoke-result', ok: true });
    } catch (error) {
        chrome.webview.postMessage({ kind: 'smoke-result', ok: false, error: error.stack || error.message });
    }
})();
