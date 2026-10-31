import { randomBytes } from 'node:crypto';
import { authorize, parseCredentials, parseTokens, TOKEN_ENDPOINT } from './oauth.js';
import { createBackup, parseBackup, MAX_BACKUP_BYTES } from './backup.js';
import { request, readJson } from './http.js';

const API = 'https://www.googleapis.com/drive/v3';
const BACKUP_NAME = 'calendar-events-v1.json';

export class DriveClient {
    #storage;
    #fetch;
    #open;
    #authorize;
    #busy = false;
    #abort = null;

    constructor({ storage, fetcher = fetch, openExternal, authorizeFn = authorize }) {
        this.#storage = storage;
        this.#fetch = fetcher;
        this.#open = openExternal;
        this.#authorize = authorizeFn;
    }

    async #state() {
        const state = await this.#storage.read();
        if (state === null) return null;
        if (state.version !== 1) throw new Error('Your saved Google connection uses an unsupported format.');
        parseCredentials({ installed: state.client });
        if (state.tokens && (typeof state.tokens.refreshToken !== 'string' || !state.tokens.refreshToken || typeof state.tokens.accessToken !== 'string' || !Number.isFinite(state.tokens.expiresAt))) {
            throw new Error('Your saved Google connection is invalid.');
        }
        return state;
    }

    async status() {
        const state = await this.#state();
        return { configured: Boolean(state?.client), connected: Boolean(state?.tokens), account: typeof state?.account === 'string' ? state.account : '', busy: this.#busy, connecting: Boolean(this.#abort) };
    }

    async #run(action) {
        if (this.#busy) throw new Error('Another Google Drive operation is in progress.');
        this.#busy = true;
        try { return await action(); }
        finally { this.#busy = false; }
    }

    configure(value) {
        return this.#run(async () => {
            const client = parseCredentials(value);
            const state = await this.#state();
            if (state?.tokens) throw new Error('Disconnect Google Drive before importing a different OAuth client.');
            await this.#storage.write({ version: 1, client });
        });
    }

    connect() {
        return this.#run(async () => {
            this.#abort = new AbortController();
            try {
                const state = await this.#state();
                if (!state?.client) throw new Error('Import your Google OAuth Desktop client JSON first.');
                if (state.tokens) throw new Error('Google Drive is already connected. Disconnect first to switch accounts.');
                const tokens = await this.#authorize(state.client, { fetcher: this.#fetch, openExternal: this.#open, signal: this.#abort.signal });
                await this.#storage.write({ ...state, tokens });
                const about = await readJson(await this.#drive(`${API}/about?fields=user(emailAddress,displayName)`));
                const account = about.user?.emailAddress || about.user?.displayName || 'Google account';
                await this.#storage.write({ ...await this.#state(), account: String(account).slice(0, 254) });
            } finally { this.#abort = null; }
        });
    }

    cancelConnect() { this.#abort?.abort(); }

    async #accessToken(force = false) {
        const state = await this.#state();
        if (!state?.tokens) throw new Error('Connect Google Drive first.');
        if (!force && state.tokens.expiresAt > Date.now() + 60_000) return state.tokens.accessToken;
        const body = new URLSearchParams({ ...state.client, grant_type: 'refresh_token', refresh_token: state.tokens.refreshToken });
        const response = await request(this.#fetch, TOKEN_ENDPOINT, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!response.ok) {
            const error = await readJson(response).catch(() => ({}));
            if (error.error === 'invalid_grant') {
                await this.#storage.write({ version: 1, client: state.client });
                throw new Error('Your Google sign-in expired or was revoked. Connect again.');
            }
            throw new Error('Google could not refresh your sign-in. Please try again.');
        }
        const tokens = parseTokens(await readJson(response), state.tokens.refreshToken);
        await this.#storage.write({ ...state, tokens });
        return tokens.accessToken;
    }

    async #drive(url, options = {}) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = await this.#accessToken(attempt > 0);
            const response = await request(this.#fetch, url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
            if (response.status === 401 && attempt === 0) { await response.body?.cancel(); continue; }
            if (response.ok) return response;
            await response.body?.cancel();
            if (response.status === 401) throw new Error('Google did not accept your sign-in. Disconnect and connect again.');
            if (response.status === 403) throw new Error('Drive access was denied. Enable Google Drive API in your OAuth project and check its permissions and storage quota.');
            if (response.status === 404) throw new Error('That Drive backup is no longer available.');
            if (response.status === 429) throw new Error('Google Drive is receiving too many requests. Wait a moment and try again.');
            throw new Error('Google Drive could not complete the request. Please try again.');
        }
    }

    upload(loadEvents) {
        return this.#run(async () => {
            const backup = createBackup(await loadEvents());
            const boundary = `calendar_${randomBytes(16).toString('hex')}`;
            const metadata = { name: BACKUP_NAME, mimeType: 'application/json', parents: ['appDataFolder'] };
            const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(backup)}\r\n--${boundary}--\r\n`;
            // Each upload is a new snapshot. Simultaneous devices cannot overwrite
            // one another's backups, and this app never deletes Drive files.
            const response = await this.#drive('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
                method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body
            });
            const file = await readJson(response);
            if (typeof file.id !== 'string' || !file.id) throw new Error('Google did not confirm the backup. Check your connection before retrying.');
            return { count: backup.events.length, createdAt: backup.createdAt };
        });
    }

    async #latestBackup() {
        let pageToken = '';
        for (let page = 0; page < 20; page++) {
            const query = new URLSearchParams({ spaces: 'appDataFolder', q: `name = '${BACKUP_NAME}' and trashed = false`,
                fields: 'files(id),nextPageToken', orderBy: 'createdTime desc', pageSize: '10', ...(pageToken ? { pageToken } : {}) });
            const result = await readJson(await this.#drive(`${API}/files?${query}`));
            const file = result.files?.[0];
            if (file) {
                if (typeof file.id !== 'string' || !/^[\w-]{1,200}$/.test(file.id)) throw new Error('Google returned an invalid backup reference.');
                const response = await this.#drive(`${API}/files/${encodeURIComponent(file.id)}?alt=media`);
                return parseBackup(await readJson(response, MAX_BACKUP_BYTES));
            }
            if (!result.nextPageToken) throw new Error('No Calendar backup was found in this Google account. Upload a backup from your other device first.');
            pageToken = result.nextPageToken;
        }
        throw new Error('Drive could not finish listing your backups. Please try again.');
    }

    restore(store, confirm) {
        return this.#run(async () => {
            const backup = await this.#latestBackup();
            if (!(await confirm({ count: backup.events.length, createdAt: backup.createdAt }))) return { cancelled: true };
            const events = await store.restore(backup.events);
            return { cancelled: false, count: events.length, createdAt: backup.createdAt };
        });
    }

    disconnect() {
        return this.#run(async () => {
            const state = await this.#state();
            if (!state) return;
            if (state.tokens) {
                const response = await request(this.#fetch, 'https://oauth2.googleapis.com/revoke', {
                    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: state.tokens.refreshToken })
                });
                await response.body?.cancel();
                if (!response.ok && response.status !== 400) throw new Error('Google could not revoke this connection. Please try again.');
            }
            await this.#storage.write({ version: 1, client: state.client });
        });
    }
}
