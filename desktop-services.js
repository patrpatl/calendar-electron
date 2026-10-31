import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { EventStore } from './event-store.js';
import { SettingsStore } from './settings-store.js';
import { SecureStore } from './drive/secure-store.js';
import { DriveClient } from './drive/client.js';

export function createDesktopServices(profile, host, cipher) {
    const store = new EventStore(join(profile, 'events.json'));
    const settings = new SettingsStore(join(profile, 'settings.json'));
    const drive = new DriveClient({
        storage: new SecureStore(join(profile, 'drive-auth.bin'), cipher),
        openExternal: url => host('open-external', url)
    });
    const actions = new Map([
        ['calendar:list', async () => ({ events: await store.list() })],
        ['calendar:save', value => store.saveRecord(value)],
        ['calendar:delete', async id => ({ events: await store.delete(id) })],
        ['settings:get', async () => ({ settings: await settings.get() })],
        ['settings:set-runtime', async runtime => ({ settings: await settings.setRuntime(runtime) })],
        ['settings:set-theme', async theme => {
            const value = await settings.setTheme(theme);
            await host('theme', value.theme);
            return { settings: value };
        }]
    ]);
    const driveActions = {
        status: async () => ({}),
        'import-client': async () => {
            const file = await host('import-client');
            if (!file) return { cancelled: true };
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
        restore: () => drive.restore(store, backup => host('confirm-restore', { count: backup.count, createdAt: backup.createdAt })),
        disconnect: async () => { await drive.disconnect(); return {}; }
    };
    for (const [name, action] of Object.entries(driveActions)) {
        actions.set(`drive:${name}`, async () => ({ ...await action(), status: await drive.status() }));
    }
    return {
        settings,
        cancel: () => drive.cancelConnect(),
        async invoke(channel, value) {
            const action = actions.get(channel);
            if (!action) return { ok: false, error: 'This operation is not available.' };
            try { return { ok: true, ...await action(value) }; }
            catch (error) { return { ok: false, error: error.message || 'This operation could not be completed.' }; }
        }
    };
}
