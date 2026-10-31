import { app, BrowserWindow, ipcMain, dialog, nativeTheme, safeStorage, shell } from 'electron';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { release } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EventStore } from './event-store.js';
import { SettingsStore } from './settings-store.js';
import { SecureStore } from './drive/secure-store.js';
import { DriveClient } from './drive/client.js';

const root = import.meta.dirname;
const entry = join(root, 'dist', 'index.html');
let mainWindow;
let store;
let settingsStore;
let drive;
let editorReady = false;
let closeRequest = null;
let allowWindowClose = false;
const supportsAcrylic = process.platform === 'win32' && Number(release().split('.')[2]) >= 22621;

function updateWindowAppearance() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const dark = nativeTheme.shouldUseDarkColors;
    const reducedTransparency = nativeTheme.prefersReducedTransparency || nativeTheme.shouldUseHighContrastColors;
    const background = dark ? '#20221f' : '#e7e9e3';
    mainWindow.setBackgroundColor(reducedTransparency ? background : '#00000000');
    if (supportsAcrylic) mainWindow.setBackgroundMaterial(reducedTransparency ? 'none' : 'acrylic');
    if (process.platform === 'darwin') mainWindow.setVibrancy(reducedTransparency ? null : 'under-window');
    else mainWindow.setTitleBarOverlay({
        color: reducedTransparency ? background : '#00000000',
        symbolColor: dark ? '#f1f2ed' : '#20221f', height: 32
    });
}

function registerStorage() {
    for (const [channel, action] of [
        ['calendar:list', async () => ({ events: await store.list() })],
        ['calendar:save', value => store.saveRecord(value)],
        ['calendar:delete', async id => ({ events: await store.delete(id) })]
    ]) {
        ipcMain.handle(channel, async (event, value) => {
            if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== pathToFileURL(entry).href) {
                return { ok: false, error: 'This window cannot access calendar data.' };
            }
            try {
                return { ok: true, ...await action(value) };
            } catch (error) {
                console.error('Calendar storage:', error);
                return { ok: false, error: error.message || 'Your change could not be saved. Please try again.' };
            }
        });
    }
    ipcMain.on('calendar:editor-ready', event => {
        if (event.sender === mainWindow?.webContents && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === pathToFileURL(entry).href) editorReady = true;
    });
    ipcMain.on('calendar:close-ready', (event, result) => {
        if (!closeRequest || event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== pathToFileURL(entry).href || result?.requestId !== closeRequest) return;
        closeRequest = null;
        if (result.ok === true) { allowWindowClose = true; mainWindow.close(); }
    });
}

function registerSettings() {
    const trusted = event => BrowserWindow.fromWebContents(event.sender) &&
        event.senderFrame === event.sender.mainFrame && event.senderFrame.url === pathToFileURL(entry).href;
    for (const [channel, action] of [
        ['settings:get', () => settingsStore.get()],
        ['settings:set-theme', async theme => {
            const settings = await settingsStore.setTheme(theme);
            nativeTheme.themeSource = settings.theme;
            updateWindowAppearance();
            for (const window of BrowserWindow.getAllWindows()) {
                window.webContents.send('settings:changed', settings);
            }
            return settings;
        }]
    ]) {
        ipcMain.handle(channel, async (event, value) => {
            if (!trusted(event)) return { ok: false, error: 'This window cannot access settings.' };
            try {
                return { ok: true, settings: await action(value) };
            } catch (error) {
                return { ok: false, error: error.message || 'Your settings could not be saved. Please try again.' };
            }
        });
    }
}

function registerDrive() {
    const trusted = event => BrowserWindow.fromWebContents(event.sender) &&
        event.senderFrame === event.sender.mainFrame && event.senderFrame.url === pathToFileURL(entry).href;
    const actions = {
        status: async () => ({}),
        'import-client': async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
                title: 'Import Google OAuth Desktop client', properties: ['openFile'], filters: [{ name: 'OAuth client JSON', extensions: ['json'] }]
            });
            if (result.canceled) return { cancelled: true };
            const file = result.filePaths[0];
            const info = await stat(file);
            if (!info.isFile() || info.size > 64 * 1024) throw new Error('Choose a Google OAuth Desktop client JSON file smaller than 64 KB.');
            let credentials;
            try { credentials = JSON.parse(await readFile(file, 'utf8')); }
            catch { throw new Error('That file is not valid JSON. Choose the Desktop OAuth client downloaded from Google Cloud.'); }
            await drive.configure(credentials);
            return {};
        },
        connect: async () => { await drive.connect(); return {}; },
        'cancel-connect': async () => { drive.cancelConnect(); return {}; },
        upload: () => drive.upload(() => store.list()),
        restore: () => drive.restore(store, async backup => {
            const result = await dialog.showMessageBox(mainWindow, {
                type: 'warning', title: 'Restore Calendar from Google Drive', buttons: ['Restore backup', 'Cancel'], defaultId: 1, cancelId: 1,
                message: `Replace this device's calendar with ${backup.count} event${backup.count === 1 ? '' : 's'} from Drive?`,
                detail: `Backup created: ${new Date(backup.createdAt).toLocaleString()}\n\nA safety copy of your current events will be saved in the local backups folder before anything is replaced.`
            });
            return result.response === 0;
        }),
        disconnect: async () => { await drive.disconnect(); return {}; }
    };
    for (const [action, run] of Object.entries(actions)) {
        ipcMain.handle(`drive:${action}`, async event => {
            if (!trusted(event)) return { ok: false, error: 'This window cannot access Google Drive.' };
            try { return { ok: true, ...await run(), status: await drive.status() }; }
            catch (error) { return { ok: false, error: error.message || 'Google Drive could not complete this action.' }; }
        });
    }
}

function createMainWindow() {
    editorReady = false;
    closeRequest = null;
    allowWindowClose = false;
    mainWindow = new BrowserWindow({
        title: 'Calendar', width: 1280, height: 860, minWidth: 760, minHeight: 620,
        backgroundColor: '#00000000', transparent: true, autoHideMenuBar: true,
        titleBarStyle: 'hidden',
        titleBarOverlay: process.platform === 'darwin' ? true : {
            color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#f1f2ed' : '#20221f', height: 32
        },
        webPreferences: {
            preload: join(root, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true
        }
    });
    updateWindowAppearance();
    mainWindow.on('close', event => {
        if (allowWindowClose || !editorReady || mainWindow.webContents.isDestroyed()) return;
        event.preventDefault();
        if (closeRequest) return;
        closeRequest = randomUUID();
        mainWindow.webContents.send('calendar:flush-editor', closeRequest);
    });
    mainWindow.webContents.on('did-start-loading', () => { editorReady = false; closeRequest = null; });
    mainWindow.webContents.on('render-process-gone', () => { editorReady = false; closeRequest = null; });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', event => event.preventDefault());
    mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.loadFile(entry).catch(error => {
        dialog.showErrorBox('Calendar could not open', `Build the app with npm run build and try again.\n\n${error.message}`);
        app.quit();
    });
}

// One process owns the local data file, even if the app is launched twice.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
    app.whenReady().then(async () => {
        nativeTheme.themeSource = 'system';
        settingsStore = new SettingsStore(join(app.getPath('userData'), 'settings.json'));
        try {
            nativeTheme.themeSource = (await settingsStore.get()).theme;
        } catch (error) {
            // Keep the calendar usable; Settings displays the read error on open.
            console.error('Calendar settings:', error.message);
        }
        nativeTheme.on('updated', updateWindowAppearance);
        store = new EventStore(join(app.getPath('userData'), 'events.json'));
        drive = new DriveClient({
            storage: new SecureStore(join(app.getPath('userData'), 'drive-auth.bin'), {
                available: async () => await safeStorage.isAsyncEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
                encrypt: value => safeStorage.encryptStringAsync(value),
                decrypt: async value => (await safeStorage.decryptStringAsync(value)).result
            }),
            openExternal: url => shell.openExternal(url)
        });
        registerStorage();
        registerSettings();
        registerDrive();
        createMainWindow();
        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
        });
    });
    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
    app.on('before-quit', () => drive?.cancelConnect());
}
