import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseHost, runSystemWebView, preferredRuntime } from '../launcher.js';
import { acquireHostLock } from '../host-lock.js';
import { SettingsStore } from '../settings-store.js';
import { createDesktopServices } from '../desktop-services.js';

test('system host success and normal close do not launch Electron', async () => {
    let fallback = 0;
    assert.equal(await chooseHost({ system: async () => 0, electron: async () => ++fallback }), 0);
    assert.equal(fallback, 0);
});

test('system host errors fall back once and Electron errors are reported', async () => {
    let fallback = 0;
    const warnings = [];
    assert.equal(await chooseHost({ system: async () => { throw new Error('runtime missing'); }, electron: async () => { fallback++; return 0; }, warn: value => warnings.push(value) }), 0);
    assert.equal(fallback, 1);
    assert.match(warnings[0], /runtime missing/);
    await assert.rejects(chooseHost({
        system: async () => { throw new Error('native failed'); },
        electron: async () => { throw new Error('electron failed'); }, warn: () => {}
    }), /electron failed/);
});

test('cancelling startup does not open another app window', async () => {
    let fallback = false;
    await chooseHost({ system: async () => { throw new DOMException('Cancelled', 'AbortError'); }, electron: async () => { fallback = true; } });
    assert.equal(fallback, false);
});

function fakeHost(onCommand) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
        write(chunk, _encoding, done) {
            const message = JSON.parse(chunk.toString());
            if (message.kind === 'native') queueMicrotask(() => emit({ kind: 'native-result', id: message.id, ok: true }));
            onCommand?.(message, child);
            done();
        }
    });
    child.kill = () => child.emit('close', null, 'SIGTERM');
    const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
    return { child, emit };
}

async function temporaryProfile(t) {
    const profile = await mkdtemp(join(tmpdir(), 'calendar-launcher-'));
    t.after(() => rm(profile, { recursive: true, force: true }));
    return profile;
}

test('launches default to Electron and honor the saved runtime on Windows', async t => {
    const profile = await temporaryProfile(t);
    assert.equal(await preferredRuntime(profile, { platform: 'win32' }), 'electron');
    const settings = new SettingsStore(join(profile, 'settings.json'));
    await settings.setRuntime('webview');
    assert.equal(await preferredRuntime(profile, { platform: 'win32' }), 'webview');
    assert.equal(await preferredRuntime(profile, { platform: 'win32', forceElectron: true }), 'electron');
    assert.equal(await preferredRuntime(profile, { platform: 'darwin' }), 'electron');
    assert.equal(await preferredRuntime(profile, { platform: 'linux' }), 'electron');
    await settings.setRuntime('electron');
    assert.equal(await preferredRuntime(profile, { platform: 'win32' }), 'electron');
});

test('damaged launch preferences open Electron and preserve the settings file', async t => {
    const profile = await temporaryProfile(t);
    const file = join(profile, 'settings.json');
    await writeFile(file, '{broken');
    const warnings = [];
    assert.equal(await preferredRuntime(profile, { platform: 'win32', warn: value => warnings.push(value) }), 'electron');
    assert.match(warnings[0], /preserved/);
    assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('WebView settings API persists engine changes and retains the theme', async t => {
    const profile = await temporaryProfile(t);
    const services = createDesktopServices(profile, async () => {}, null);
    await services.invoke('settings:set-theme', 'dark');
    const changed = await services.invoke('settings:set-runtime', 'webview');
    assert.deepEqual(changed, { ok: true, settings: { theme: 'dark', runtime: 'webview' } });
    assert.equal((await services.invoke('settings:set-runtime', 'invalid')).ok, false);
    assert.equal(await preferredRuntime(profile, { platform: 'win32' }), 'webview');
});

test('a native host that exits before readiness triggers fallback', async t => {
    const profile = await temporaryProfile(t);
    const { child } = fakeHost();
    const run = runSystemWebView({ profile, spawnHost: () => child });
    child.emit('close', 0);
    await assert.rejects(run, /before closing normally/);
});

test('a hung native startup is stopped before fallback', async t => {
    const profile = await temporaryProfile(t);
    let stopped = false;
    const { child } = fakeHost((message, host) => {
        if (message.kind === 'quit') { stopped = true; queueMicrotask(() => host.emit('close', 0)); }
    });
    await assert.rejects(runSystemWebView({ profile, spawnHost: () => child, startupTimeout: 30 }), /did not finish starting/);
    assert.equal(stopped, true);
});

test('closing the native window during startup exits without reopening Electron', async t => {
    const profile = await temporaryProfile(t);
    const { child, emit } = fakeHost();
    const run = runSystemWebView({ profile, spawnHost: () => child });
    emit({ kind: 'user-close' });
    child.emit('close', 0);
    assert.equal(await run, 0);
});

test('normal native launches show their window and smoke launches stay hidden', async t => {
    const profile = await temporaryProfile(t);
    for (const smokeScript of [undefined, 'offscreen-smoke.js']) {
        const { child, emit } = fakeHost();
        const run = runSystemWebView({
            profile, smokeScript,
            spawnHost(_file, _args, options) {
                assert.equal(options.windowsHide, Boolean(smokeScript));
                return child;
            }
        });
        emit({ kind: 'user-close' });
        child.emit('close', 0);
        assert.equal(await run, 0);
    }
});

test('native crash waits for event writes to settle and rejects unknown API channels', async t => {
    const profile = await temporaryProfile(t);
    const replies = [];
    const { child, emit } = fakeHost(message => {
        if (message.kind === 'result') replies.push(message);
    });
    const run = runSystemWebView({ profile, spawnHost: () => child });
    emit({ kind: 'ready' });
    emit({ kind: 'invoke', id: 1, channel: 'calendar:save', value: { title: 'Survives native crash', date: '2026-10-31', allDay: true, color: 'teal', notes: '' } });
    emit({ kind: 'invoke', id: 2, channel: 'protect', value: 'untrusted' });
    await Promise.resolve();
    child.emit('close', 1);
    await assert.rejects(run);
    const data = JSON.parse(await readFile(join(profile, 'events.json'), 'utf8'));
    assert.equal(data.events[0].title, 'Survives native crash');
    // The invalid channel is handled as an API error; it cannot reach native RPC.
    assert.equal(replies.find(reply => reply.id === 2)?.result.ok, false);
});

test('both hosts share a single profile lock and a second launch focuses the owner', { skip: process.platform !== 'win32' }, async t => {
    const profile = await temporaryProfile(t);
    let focused = 0;
    const release = await acquireHostLock(profile, () => { focused++; });
    try {
        assert.equal(await acquireHostLock(profile.toUpperCase(), () => {}), null);
        assert.equal(focused, 1);
    } finally { await release(); }
    const reopened = await acquireHostLock(profile, () => {});
    await reopened();
});
