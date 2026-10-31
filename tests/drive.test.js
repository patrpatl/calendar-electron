import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DriveClient } from '../drive/client.js';
import { createBackup, parseBackup } from '../drive/backup.js';
import { readJson } from '../drive/http.js';
import { EventStore } from '../event-store.js';

const client = { client_id: '123-test.apps.googleusercontent.com', client_secret: 'desktop-secret' };
const event = { id: 'example-id', title: 'A plan', date: '2026-10-30', allDay: true, start: '', end: '', color: 'teal', notes: '' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const tokenValue = { access_token: 'fresh-access', token_type: 'Bearer', expires_in: 3600 };

function fixture() {
    const storage = {
        value: null,
        async read() { return structuredClone(this.value); },
        async write(value) { this.value = structuredClone(value); }
    };
    const calls = [];
    let remote = createBackup([event]);
    let refreshError = null;
    let unauthorized = false;
    let apiStatus = 200;
    let holdUpload;
    const service = new DriveClient({ storage,
        openExternal: async () => { throw new Error('No real browser or Google request is allowed in this test.'); },
        authorizeFn: async () => ({ accessToken: 'initial-access', refreshToken: 'refresh-secret', expiresAt: Date.now() + 3600_000 }),
        fetcher: async (url, options) => {
            calls.push({ url: String(url), options });
            const parsed = new URL(url);
            if (parsed.pathname === '/token') return refreshError ? json({ error: refreshError }, 400) : json(tokenValue);
            if (parsed.pathname === '/revoke') return json({});
            if (apiStatus !== 200) return json({}, apiStatus);
            if (parsed.pathname === '/drive/v3/about') return json({ user: { emailAddress: 'test@example.com' } });
            if (parsed.pathname === '/upload/drive/v3/files') {
                if (holdUpload) await holdUpload;
                if (unauthorized) { unauthorized = false; return json({}, 401); }
                return json({ id: 'backup-1' });
            }
            if (parsed.pathname === '/drive/v3/files') return json({ files: remote === null ? [] : [{ id: 'backup-1' }] });
            if (parsed.pathname === '/drive/v3/files/backup-1') return json(remote);
            throw new Error(`Unexpected test endpoint: ${parsed.pathname}`);
        }
    });
    return { service, storage, calls, setRemote: value => { remote = value; }, setRefreshError: value => { refreshError = value; }, rejectOnce: () => { unauthorized = true; }, setApiStatus: value => { apiStatus = value; }, hold: value => { holdUpload = value; } };
}

async function connected() {
    const value = fixture();
    await value.service.configure({ installed: client });
    await value.service.connect();
    return value;
}

test('Drive is optional and public status never exposes credentials or tokens', async () => {
    const { service } = fixture();
    assert.deepEqual(await service.status(), { configured: false, connected: false, account: '', busy: false, connecting: false });
    await assert.rejects(service.connect(), /Import/);
    const { service: signedIn } = await connected();
    const status = await signedIn.status();
    assert.equal(status.account, 'test@example.com');
    assert.equal(status.connected, true);
    assert.doesNotMatch(JSON.stringify(status), /secret|accessToken|refreshToken|client_id/);
    await assert.rejects(signedIn.configure({ installed: client }), /Disconnect/);
});

test('upload creates a private snapshot with only calendar data, not OAuth or settings', async () => {
    const { service, calls } = await connected();
    assert.equal((await service.upload(async () => [event])).count, 1);
    const upload = calls.find(call => call.url.includes('/upload/'));
    assert.equal(upload.options.method, 'POST');
    assert.equal(upload.options.headers.Authorization, 'Bearer initial-access');
    assert.match(upload.options.body, /"parents":\["appDataFolder"\]/);
    assert.match(upload.options.body, /"app":"calendar-electron"/);
    assert.match(upload.options.body, /"title":"A plan"/);
    assert.doesNotMatch(upload.options.body, /refresh-secret|desktop-secret|client_id/);
});

test('refresh preserves the refresh token and retries one unauthorized request', async () => {
    const { service, storage, calls, rejectOnce } = await connected();
    storage.value.tokens.expiresAt = 0;
    rejectOnce();
    await service.upload(async () => [event]);
    assert.equal(calls.filter(call => call.url.endsWith('/token')).length, 2);
    assert.equal(calls.filter(call => call.url.includes('/upload/')).length, 2);
    assert.equal(storage.value.tokens.refreshToken, 'refresh-secret');
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer fresh-access');
});

test('revoked refresh tokens require reconnect and access errors are readable', async () => {
    const { service, storage, setRefreshError } = await connected();
    storage.value.tokens.expiresAt = 0;
    setRefreshError('invalid_grant');
    await assert.rejects(service.upload(async () => []), /revoked/);
    assert.equal((await service.status()).connected, false);
    const other = await connected();
    other.setApiStatus(403);
    await assert.rejects(other.service.upload(async () => []), /Enable Google Drive API/);
});

test('simultaneous operations are rejected and cancellation does not overwrite events', async () => {
    const { service, hold } = await connected();
    let release;
    hold(new Promise(resolve => { release = resolve; }));
    const uploading = service.upload(async () => []);
    await assert.rejects(service.upload(async () => []), /in progress/);
    assert.equal((await service.status()).busy, true);
    release();
    await uploading;
    let restored = false;
    const result = await service.restore({ restore: async () => { restored = true; } }, async preview => {
        assert.equal(preview.count, 1);
        return false;
    });
    assert.equal(result.cancelled, true);
    assert.equal(restored, false);
});

test('restore validates downloaded events before confirmation or touching local data', async () => {
    const { service, setRemote } = await connected();
    let touched = false;
    const store = { restore: async () => { touched = true; } };
    const confirm = async () => { touched = true; return true; };
    for (const remote of [{ version: 5 }, { ...createBackup([event]), events: [event, event] }, { ...createBackup([event]), events: [{ ...event, date: '2026-02-30' }] }]) {
        setRemote(remote);
        await assert.rejects(service.restore(store, confirm));
        assert.equal(touched, false);
    }
    setRemote(null);
    await assert.rejects(service.restore(store, confirm), /No Calendar backup/);
});

test('restoring to the real event store makes a safety copy before replacing events', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'calendar-drive-restore-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new EventStore(join(directory, 'events.json'));
    const old = await store.save({ ...event, id: undefined, title: 'Local event' });
    const { service } = await connected();
    const result = await service.restore(store, async () => true);
    assert.equal(result.count, 1);
    assert.deepEqual(await store.list(), [event]);
    const files = await readdir(join(directory, 'backups'));
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'backups', files[0]), 'utf8')).events, old);
});

test('disconnect revokes the refresh token and keeps only the imported client', async () => {
    const { service, storage, calls } = await connected();
    await service.disconnect();
    assert.equal(calls.at(-1).url, 'https://oauth2.googleapis.com/revoke');
    assert.equal(calls.at(-1).options.body.get('token'), 'refresh-secret');
    assert.deepEqual(storage.value, { version: 1, client });
    assert.equal((await service.status()).connected, false);
});

test('backup validation and bounded downloads reject invalid or oversized data', async () => {
    assert.equal(parseBackup(createBackup([event])).events.length, 1);
    assert.throws(() => parseBackup({ ...createBackup([]), createdAt: 'invalid' }));
    await assert.rejects(readJson(new Response('123456789', { headers: { 'content-length': '9' } }), 8), /allowed size/);
    await assert.rejects(readJson(new Response('123456789'), 8), /allowed size/);
});
