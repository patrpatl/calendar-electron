const { app, BrowserWindow, ipcMain, nativeTheme, safeStorage } = require('electron');
const assert = require('node:assert/strict');
const { mkdir, writeFile, readFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const artifacts = resolve(__dirname, '..', '.test-artifacts');
const profile = join(artifacts, `profile-${Date.now()}`);
app.setName('Calendar Smoke');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-timer-throttling');
const timeout = setTimeout(() => { console.error('Electron smoke test timed out.'); app.exit(1); }, 60_000);

const ready = new Promise((resolveWindow, reject) => {
    app.once('browser-window-created', (_event, window) => {
        window.on('show', () => window.hide());
        window.hide();
        window.webContents.setBackgroundThrottling(false);
        window.webContents.on('preload-error', (_event, _path, error) => reject(error));
        window.webContents.on('render-process-gone', (_event, details) => reject(new Error(JSON.stringify(details))));
        window.webContents.once('did-finish-load', () => resolveWindow(window));
    });
});

async function run() {
    await mkdir(profile, { recursive: true });
    await import(pathToFileURL(resolve(__dirname, '..', 'main.js')).href);
    let window = await ready;
    const js = source => window.webContents.executeJavaScript(`(async () => { const $ = id => document.getElementById(id); ${source} })()`);
    const wait = async (source, label) => {
        const start = Date.now();
        while (!(await js(`return Boolean(${source});`))) {
            if (Date.now() - start > 7000) {
                const theme = await js("return { theme: document.documentElement.dataset.bsTheme, mediaDark: matchMedia('(prefers-color-scheme: dark)').matches }; ");
                throw new Error(`Timed out: ${label}; ${JSON.stringify({ ...theme, source: nativeTheme.themeSource, nativeDark: nativeTheme.shouldUseDarkColors })}`);
            }
            await new Promise(resolveWait => setTimeout(resolveWait, 30));
        }
    };

    await wait("!$('new-event').disabled", 'load events through preload and main IPC');
    assert.equal(await js("return document.querySelectorAll('[data-date]').length;"), 42);
    assert.equal(await js("return getComputedStyle($('new-event')).backgroundColor;"), 'rgb(60, 133, 39)');
    assert.equal(await js("return typeof window.require;"), 'undefined');
    assert.equal(await js("return typeof window.process;"), 'undefined');
    assert.equal(await js("return $('app-error').hidden;"), true);
    console.log('PASS: Electron, preload, Bootstrap CSS, and sandboxed renderer load.');

    assert.equal(nativeTheme.themeSource, 'system');
    const systemTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    assert.equal(await js("return document.documentElement.dataset.bsTheme;"), systemTheme);
    assert.equal(await js("return getComputedStyle($('month-heading')).userSelect;"), 'none');
    assert.equal(await js("return getComputedStyle($('search')).userSelect;"), 'text');
    assert.equal(await js("return getComputedStyle(document.querySelector('.window-titlebar')).getPropertyValue('-webkit-app-region');"), 'drag');
    assert.equal(window.getOpacity(), 1, 'window effects keep text fully opaque');
    // Electron omits the alpha channel from getBackgroundColor().
    assert.equal(window.getBackgroundColor(), nativeTheme.prefersReducedTransparency || nativeTheme.shouldUseHighContrastColors ? (nativeTheme.shouldUseDarkColors ? '#20221f' : '#e7e9e3') : '#000000');
    // Overlay.visible is false while the native window is hidden. Updating it
    // succeeds only when the native caption controls were enabled at creation.
    if (process.platform !== 'darwin') assert.doesNotThrow(() => window.setTitleBarOverlay({ height: 32 }));
    assert.equal(await js("return getComputedStyle($('new-event')).borderRadius;"), '0px');
    console.log('PASS: OS theme at startup, Ore controls, text selection rules, transparency, and native caption overlay.');

    await js("$('open-settings').click();");
    await wait("!$('theme-options').disabled", 'load Settings');
    await wait("!$('drive-import').disabled", 'load optional Drive settings');
    assert.equal(await js("return $('drive-connect').disabled;"), true);
    assert.equal(await js("return $('drive-backup-actions').hidden;"), true);
    const driveStatus = await js("return window.driveAPI.status();");
    assert.equal(driveStatus.ok, true);
    assert.equal(driveStatus.status.configured, false);
    assert.equal(driveStatus.status.connected, false);
    assert.equal((await js("return window.driveAPI.connect();")).ok, false);
    assert.equal((await js("return window.driveAPI.upload();")).ok, false);
    assert.equal((await js("return window.driveAPI.restore();")).ok, false);
    assert.equal(await js("return $('drive-error').hidden;"), true);
    if (await safeStorage.isAsyncEncryptionAvailable()) {
        const { SecureStore } = await import(pathToFileURL(resolve(__dirname, '..', 'drive', 'secure-store.js')).href);
        const encryptedFile = join(profile, 'cipher-check.bin');
        const encryptedStore = new SecureStore(encryptedFile, {
            available: () => safeStorage.isAsyncEncryptionAvailable(),
            encrypt: value => safeStorage.encryptStringAsync(value),
            decrypt: async value => (await safeStorage.decryptStringAsync(value)).result
        });
        await encryptedStore.write({ test: 'dummy-refresh-token' });
        assert.deepEqual(await encryptedStore.read(), { test: 'dummy-refresh-token' });
        assert.equal((await readFile(encryptedFile)).includes(Buffer.from('dummy-refresh-token')), false);
    }
    console.log('PASS: Drive stays optional, unconfigured operations fail safely, and OS credential encryption round-trips.');
    assert.equal(await js("return document.querySelector('input[name=\"theme\"]:checked').value;"), 'system');
    await js("document.querySelector('input[name=\"theme\"][value=\"dark\"]').click();");
    await wait("$('settings-status').textContent === 'Theme saved.' && !$('theme-options').disabled", 'save dark preference');
    assert.equal(nativeTheme.themeSource, 'dark');
    assert.equal(JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')).theme, 'dark');
    await js("$('done-settings').click();");
    window.webContents.reload();
    await wait("!$('new-event').disabled", 'reload with saved theme');
    assert.equal(await js("return document.documentElement.dataset.bsTheme;"), 'dark');
    await js("$('open-settings').click();");
    await wait("!$('theme-options').disabled", 'reopen Settings');
    assert.equal(await js("return document.querySelector('input[name=\"theme\"]:checked').value;"), 'dark');
    await js("document.querySelector('input[name=\"theme\"][value=\"light\"]').click();");
    await wait("$('settings-status').textContent === 'Theme saved.' && !$('theme-options').disabled", 'choose light');
    assert.equal(nativeTheme.themeSource, 'light');
    assert.equal((await js("return window.settingsAPI.setTheme('invalid');")).ok, false);
    assert.equal(nativeTheme.themeSource, 'light');
    await js("document.querySelector('input[name=\"theme\"][value=\"system\"]').click();");
    await wait("$('settings-status').textContent === 'Theme saved.' && !$('theme-options').disabled", 'restore system theme');
    assert.equal(nativeTheme.themeSource, 'system');
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));");
    assert.equal(await js("return $('event-dialog').open;"), false, 'calendar shortcuts stay inactive in Settings');
    await js("$('done-settings').click();");
    console.log('PASS: Settings UI, persisted themes, native appearance, invalid input, and dialog keyboard focus.');

    const heading = await js("return $('month-heading').textContent;");
    await js("$('next-month').click();");
    assert.notEqual(await js("return $('month-heading').textContent;"), heading);
    await js("$('today').click();");
    assert.equal(await js("return $('month-heading').textContent;"), heading);
    const selected = await js("return document.querySelector('[data-date][tabindex=\"0\"]').dataset.date;");
    await js("document.querySelector('[data-date][tabindex=\"0\"]').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));");
    assert.notEqual(await js("return document.querySelector('[data-date][tabindex=\"0\"]').dataset.date;"), selected);
    await js("$('today').click(); $('month-picker').value = '2024-02'; $('month-picker').dispatchEvent(new Event('change'));");
    assert.equal(await js("return [...document.querySelectorAll('.day-cell:not(.outside-month)')].length;"), 29);
    await js("$('today').click();");
    console.log('PASS: Month navigation, Today, date keyboard controls, and leap-year picker.');

    await js("$('new-event').click(); $('event-title').value = 'Smoke test <b>plan</b>'; $('event-notes').value = 'Notes for search: mango'; $('event-form').requestSubmit();");
    await wait("!$('event-dialog').open", 'create event');
    assert.equal(await js("return $('day-events').querySelectorAll('.event-card').length;"), 1);
    assert.equal(await js("return $('day-events').querySelector('.event-card-title').textContent;"), 'Smoke test <b>plan</b>');
    assert.equal(await js("return $('day-events').querySelectorAll('b').length;"), 0);
    const persisted = JSON.parse(await readFile(join(profile, 'events.json'), 'utf8'));
    assert.equal(persisted.events.length, 1);
    await window.webContents.reload();
    await wait("!$('new-event').disabled && $('day-events').querySelector('.event-card')", 'reload saved event');
    console.log('PASS: Create, safe text rendering, disk persistence, and reload.');

    await js("$('day-events').querySelector('.event-card').click(); $('event-title').value = 'Updated meeting'; $('event-all-day').checked = false; $('event-all-day').dispatchEvent(new Event('change')); $('event-start').value = '10:00'; $('event-end').value = '09:00'; $('event-form').requestSubmit();");
    await wait("!$('form-error').hidden", 'reject end before start');
    assert.equal(await js("return $('event-dialog').open;"), true);
    await js("$('event-end').value = '11:30'; document.querySelector('input[name=\"color\"][value=\"blue\"]').checked = true; $('event-form').requestSubmit();");
    await wait("!$('event-dialog').open", 'edit timed event');
    assert.equal(await js("return $('day-events').querySelector('.event-card').dataset.color;"), 'blue');
    const edited = JSON.parse(await readFile(join(profile, 'events.json'), 'utf8')).events[0];
    assert.equal(edited.start, '10:00');
    assert.equal(edited.end, '11:30');
    await js("$('search').value = 'MANGO'; $('search').dispatchEvent(new Event('input'));");
    assert.equal(await js("return $('search-results').querySelectorAll('.event-card').length;"), 1);
    await js("$('search').value = 'not-found'; $('search').dispatchEvent(new Event('input'));");
    assert.equal(await js("return $('search-results').querySelectorAll('.event-card').length;"), 0);
    await js("$('search').value = ''; $('search').dispatchEvent(new Event('input'));");
    const invalid = await js("return window.calendarAPI.save({title: ''});");
    assert.equal(invalid.ok, false);
    console.log('PASS: Editing, time validation, colors, search, and main-process validation.');

    await js("$('day-events').querySelector('.event-card').click(); $('delete-event').click();");
    assert.equal(await js("return $('delete-confirmation').hidden;"), false);
    assert.equal(JSON.parse(await readFile(join(profile, 'events.json'), 'utf8')).events.length, 1);
    await js("$('cancel-delete').click(); $('close-dialog').click(); const day = document.querySelector('[data-date][tabindex=\"0\"]'); day.click(); document.querySelector('[data-date][tabindex=\"0\"]').click();");
    assert.equal(await js("return $('event-dialog').open;"), true);
    await js("$('close-dialog').click(); $('day-events').querySelector('.event-card').click(); $('delete-event').click(); $('confirm-delete').click();");
    await wait("!$('event-dialog').open && !$('day-events').querySelector('.event-card')", 'confirm delete');
    assert.equal(JSON.parse(await readFile(join(profile, 'events.json'), 'utf8')).events.length, 0);
    console.log('PASS: Double-click editor, delete confirmation, and persisted deletion.');

    const validFile = await readFile(join(profile, 'events.json'), 'utf8');
    await writeFile(join(profile, 'events.json'), '{broken');
    window.webContents.reload();
    await wait("!$('app-error').hidden", 'damaged-file warning');
    assert.equal(await js("return $('new-event').disabled;"), true);
    assert.equal(await readFile(join(profile, 'events.json'), 'utf8'), '{broken');
    await writeFile(join(profile, 'events.json'), validFile);
    await js("$('retry-load').click();");
    await wait("$('app-error').hidden && !$('new-event').disabled", 'retry after restoring file');
    console.log('PASS: Visible storage error, preserved damaged file, and retry recovery.');

    // A few disposable plans make the visual review representative of normal use.
    await js(`
        const date = document.querySelector('[data-date][tabindex="0"]').dataset.date;
        for (const [title, color, allDay, start, end, notes, offset] of [
            ['A little time to reset', 'teal', true, '', '', 'A slow start and a fresh page.', 0],
            ['Project catch-up', 'blue', false, '10:00', '10:45', 'Bring a few ideas for the week ahead.', 0],
            ['Dinner with friends', 'rose', false, '18:30', '', 'Something good around the table.', 0],
            ['Make something', 'violet', true, '', '', '', 2],
            ['Weekend walk', 'amber', false, '08:00', '', 'Take the long way home.', 4]
        ]) {
            const day = new Date(date + 'T12:00:00'); day.setDate(day.getDate() + offset);
            const key = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0');
            const result = await window.calendarAPI.save({ title, date: key, color, allDay, start, end, notes });
            if (!result.ok) throw new Error(result.error);
        }
    `);
    window.webContents.reload();
    await wait("!$('new-event').disabled && $('day-events').querySelectorAll('.event-card').length === 3", 'visual fixture');
    // Native hidden windows may have no capture surface on Windows. Use an
    // offscreen renderer of the same built page for screenshots only.
    const originalWindow = window;
    const { EventStore } = await import(pathToFileURL(resolve(__dirname, '..', 'event-store.js')).href);
    const visualStore = new EventStore(join(profile, 'events.json'));
    nativeTheme.themeSource = 'light';
    const visualWindow = new BrowserWindow({
        show: false, width: 1280, height: 860,
        webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, preload: resolve(__dirname, '..', 'preload.cjs') }
    });
    ipcMain.removeHandler('calendar:list');
    ipcMain.handle('calendar:list', async event => {
        assert.ok([originalWindow.webContents, visualWindow.webContents].includes(event.sender));
        return { ok: true, events: await visualStore.list() };
    });
    window = visualWindow;
    await window.loadFile(resolve(__dirname, '..', 'dist', 'index.html'));
    await wait("!$('new-event').disabled && $('day-events').querySelectorAll('.event-card').length === 3", 'offscreen visual fixture');
    nativeTheme.themeSource = 'dark';
    await wait("document.documentElement.dataset.bsTheme === 'dark'", 'live dark theme');
    assert.equal(await js("return getComputedStyle($('month-heading')).color;"), 'rgb(240, 242, 233)');
    await js("$('new-event').click(); $('event-title').value = 'Selectable input'; $('event-title').select();");
    assert.equal(await js("return $('event-title').selectionEnd - $('event-title').selectionStart;"), 16);
    assert.equal(await js("return getComputedStyle($('event-title')).userSelect;"), 'text');
    assert.equal(await js("return getComputedStyle($('event-title')).backgroundColor;"), 'rgb(32, 39, 27)');
    await js("$('close-dialog').click();");
    nativeTheme.themeSource = 'light';
    await wait("document.documentElement.dataset.bsTheme === 'light'", 'live light theme');
    assert.equal(await js("return getComputedStyle($('month-heading')).color;"), 'rgb(36, 39, 34)');
    console.log('PASS: Live dark/light switching, dark editor contrast, and editable text selection.');
    const sidebarWidth = await js("return document.querySelector('.agenda-panel').clientWidth;");
    assert.equal(await js("return getComputedStyle(document.querySelector('.agenda-panel'), '::-webkit-scrollbar-thumb').backgroundColor;"), 'rgba(0, 0, 0, 0)');
    assert.equal(await js("return getComputedStyle(document.querySelector('.agenda-panel'), '::-webkit-scrollbar-thumb').borderRadius;"), '0px');
    await js("document.querySelector('.agenda-panel').scrollTop = 80;");
    await wait("document.querySelector('.agenda-panel').classList.contains('is-scrolling')", 'show sidebar scrollbar while scrolling');
    await wait("getComputedStyle(document.querySelector('.agenda-panel'), '::-webkit-scrollbar-thumb').backgroundColor !== 'rgba(0, 0, 0, 0)'", 'paint visible scrollbar thumb');
    assert.equal(await js("return document.querySelector('.agenda-panel').clientWidth;"), sidebarWidth);
    await writeFile(join(artifacts, 'calendar-scrolling.png'), (await window.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    await wait("!document.querySelector('.agenda-panel').classList.contains('is-scrolling')", 'stop scrolling');
    await wait("getComputedStyle(document.querySelector('.agenda-panel'), '::-webkit-scrollbar-thumb').backgroundColor === 'rgba(0, 0, 0, 0)'", 'fade sidebar scrollbar');
    await js("document.querySelector('.agenda-panel').scrollTop = 0;");
    await wait("!document.querySelector('.agenda-panel').classList.contains('is-scrolling')", 'reset sidebar scroll');
    console.log('PASS: Square scrollbar thumb appears during scrolling, fades when idle, and keeps the content width stable.');
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
    assert.equal(await js("return document.documentElement.scrollHeight <= window.innerHeight;"), true, 'desktop calendar fits the window');
    await writeFile(join(artifacts, 'calendar-desktop.png'), (await window.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    await js("$('day-events').querySelector('.event-card').click();");
    await writeFile(join(artifacts, 'calendar-editor.png'), (await window.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    await js("$('close-dialog').click();");
    nativeTheme.themeSource = 'dark';
    await wait("document.documentElement.dataset.bsTheme === 'dark'", 'dark screenshot');
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
    await writeFile(join(artifacts, 'calendar-desktop-dark.png'), (await window.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    await js("$('open-settings').click();");
    await wait("!$('theme-options').disabled", 'Settings screenshot');
    await writeFile(join(artifacts, 'calendar-settings-dark.png'), (await window.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    // Exercise connected and error UI states without contacting Google or opening
    // a browser/file picker. Real OAuth/Drive behavior is tested with fake HTTP.
    const cloudFixture = { configured: false, connected: false, account: '', busy: false, connecting: false };
    let failUpload = false;
    for (const action of ['status', 'import-client', 'connect', 'upload', 'restore', 'disconnect']) {
        ipcMain.removeHandler(`drive:${action}`);
        ipcMain.handle(`drive:${action}`, async event => {
            assert.equal(event.sender, visualWindow.webContents);
            if (action === 'import-client') cloudFixture.configured = true;
            if (action === 'connect') { cloudFixture.connected = true; cloudFixture.account = 'demo@example.com'; }
            if (action === 'disconnect') { cloudFixture.connected = false; cloudFixture.account = ''; }
            if (action === 'upload' && failUpload) return { ok: false, error: 'Could not reach Google. Check your connection and try again.' };
            return { ok: true, status: { ...cloudFixture }, ...(action === 'upload' ? { count: 5 } : {}), ...(action === 'restore' ? { cancelled: true } : {}) };
        });
    }
    await js("$('done-settings').click(); $('open-settings').click();");
    await wait("!$('drive-import').disabled", 'Drive setup UI');
    await js("$('drive-import').click();");
    await wait("!$('drive-connect').disabled", 'OAuth client imported UI');
    await js("$('drive-connect').click();");
    await wait("!$('drive-backup-actions').hidden && !$('drive-upload').disabled", 'connected Drive UI');
    assert.equal(await js("return $('drive-account').textContent;"), 'demo@example.com');
    await js("$('drive-upload').click();");
    await wait("$('drive-status').textContent === 'Backed up 5 events to Drive.'", 'upload feedback');
    await js("$('drive-restore').click();");
    await wait("$('drive-status').textContent.startsWith('Restore cancelled.')", 'cancelled restore feedback');
    failUpload = true;
    await js("$('drive-upload').click();");
    await wait("!$('drive-error').hidden && !$('drive-upload').disabled", 'visible network error and retry');
    assert.match(await js("return $('drive-error').textContent;"), /Check your connection/);
    failUpload = false;
    await js("$('drive-upload').click();");
    await wait("$('drive-error').hidden && !$('drive-upload').disabled", 'upload retry');
    await new Promise(resolveWait => setTimeout(resolveWait, 150));
    await writeFile(join(artifacts, 'calendar-drive-connected.png'), (await window.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    await js("$('drive-disconnect').click();");
    await wait("$('drive-backup-actions').hidden && !$('drive-connect').disabled", 'disconnect feedback');
    console.log('PASS: Drive Settings setup, connection, upload, restore cancellation, network errors, retry, and disconnect UI.');
    await js("$('done-settings').click();");
    await wait("document.activeElement.id === 'open-settings'", 'restore focus after Settings closes');
    await js("$('day-events').querySelector('.event-card').click();");
    await writeFile(join(artifacts, 'calendar-editor-dark.png'), (await window.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    await js("$('close-dialog').click();");
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    assert.equal(await js("return getComputedStyle(document.body).backgroundColor;"), 'rgb(32, 34, 31)');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    window.webContents.debugger.detach();
    window.setSize(780, 740);
    await new Promise(resolveWait => setTimeout(resolveWait, 150));
    assert.equal(await js("return document.documentElement.scrollWidth <= window.innerWidth;"), true);
    assert.equal(await js("return document.documentElement.clientWidth;"), await js("return window.innerWidth;"), 'page has no native scrollbar gutter');
    assert.equal(await js("return getComputedStyle(document.documentElement).scrollbarWidth;"), 'none');
    await writeFile(join(artifacts, 'calendar-compact.png'), (await window.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    await js("document.scrollingElement.scrollTop = 100;");
    await wait("document.documentElement.classList.contains('is-scrolling')", 'show page scrollbar');
    await wait("getComputedStyle(document.querySelector('.page-scrollbar')).opacity === '1'", 'show overlay thumb');
    assert.equal(await js("return document.querySelector('.page-scrollbar').hidden;"), false);
    await writeFile(join(artifacts, 'calendar-page-scrolling.png'), (await window.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
    await wait("!document.documentElement.classList.contains('is-scrolling')", 'hide page scrollbar');
    await wait("getComputedStyle(document.querySelector('.page-scrollbar')).opacity === '0'", 'fade page overlay scrollbar');
    await js("document.querySelector('.page-scrollbar-thumb').focus(); document.querySelector('.page-scrollbar-thumb').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));");
    await wait("document.scrollingElement.scrollTop >= document.scrollingElement.scrollHeight - window.innerHeight - 1", 'keyboard scrolling with overlay thumb');
    window = originalWindow;
    await js("const result = await window.calendarAPI.list(); for (const event of result.events) await window.calendarAPI.delete(event.id);");
    console.log('PASS: Desktop and compact layouts; screenshots saved to .test-artifacts.');
    nativeTheme.themeSource = 'system';
    clearTimeout(timeout);
    app.exit(0);
}

run().catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
