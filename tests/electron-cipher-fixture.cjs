const { app, safeStorage } = require('electron');
const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const profile = process.argv[2];
const mode = process.argv[3];
const started = performance.now();
app.setPath('userData', profile);
app.setPath('sessionData', profile);
if (mode === 'render') {
    app.once('browser-window-created', (_event, window) => {
        window.on('show', () => window.hide());
        window.hide();
        window.webContents.once('did-finish-load', async () => {
            try {
                for (let attempts = 0; attempts < 250; attempts++) {
                    if (await window.webContents.executeJavaScript("!document.getElementById('new-event').disabled")) {
                        const result = await window.webContents.executeJavaScript('calendarAPI.list()');
                        assert.equal(result.ok, true);
                        assert.equal(result.events.length, 2);
                        console.log(`PASS: Electron fallback opened the same calendar in ${Math.round(performance.now() - started)} ms (main process).`);
                        app.quit();
                        return;
                    }
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
                throw new Error('Electron calendar did not finish loading.');
            } catch (error) { console.error(error); app.exit(1); }
        });
    });
    import(require('node:url').pathToFileURL(join(__dirname, '..', 'main.js')).href).catch(error => { console.error(error); app.exit(1); });
} else app.whenReady().then(async () => {
    try {
        assert.equal(await safeStorage.isAsyncEncryptionAvailable(), true);
        if (mode === 'seed') {
            await writeFile(join(profile, 'electron-cipher.bin'), await safeStorage.encryptStringAsync('Electron to WebView: \u65e5\u672c\u8a9e'));
        } else {
            const decrypted = await safeStorage.decryptStringAsync(await readFile(join(profile, 'webview-cipher.bin')));
            assert.equal(decrypted.result, 'WebView to Electron: \u65e5\u672c\u8a9e');
        }
        app.quit();
    } catch (error) { console.error(error); app.exit(1); }
});
