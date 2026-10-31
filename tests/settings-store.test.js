import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../settings-store.js';

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'calendar-settings-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'settings.json');
    return { file, store: new SettingsStore(file) };
}

test('settings default to system theme and Electron, and a saved theme survives reopening', async t => {
    const { file, store } = await fixture(t);
    assert.deepEqual(await store.get(), { theme: 'system', runtime: 'electron' });
    await store.setTheme('dark');
    assert.deepEqual(await new SettingsStore(file).get(), { theme: 'dark', runtime: 'electron' });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, theme: 'dark', runtime: 'electron' });
    await store.setTheme('light');
    await store.setTheme('system');
    assert.deepEqual(await new SettingsStore(file).get(), { theme: 'system', runtime: 'electron' });
});

test('invalid settings never replace a saved theme, and writes retain their order', async t => {
    const { store } = await fixture(t);
    await store.setTheme('light');
    await assert.rejects(store.setTheme('invalid'));
    await assert.rejects(store.setTheme({ theme: 'dark' }));
    assert.deepEqual(await store.get(), { theme: 'light', runtime: 'electron' });
    await Promise.all([store.setTheme('dark'), store.setTheme('system'), store.setTheme('light')]);
    assert.deepEqual(await store.get(), { theme: 'light', runtime: 'electron' });
});

test('older settings keep their theme and default to Electron without rewriting the file', async t => {
    const { file, store } = await fixture(t);
    const original = '{"version":1,"theme":"dark"}';
    await writeFile(file, original);
    assert.deepEqual(await store.get(), { theme: 'dark', runtime: 'electron' });
    assert.equal(await readFile(file, 'utf8'), original);
    await store.setRuntime('webview');
    assert.deepEqual(await new SettingsStore(file).get(), { theme: 'dark', runtime: 'webview' });
});

test('runtime and theme updates preserve each other, including concurrent changes', async t => {
    const { file, store } = await fixture(t);
    await Promise.all([store.setRuntime('webview'), store.setTheme('dark')]);
    assert.deepEqual(await new SettingsStore(file).get(), { theme: 'dark', runtime: 'webview' });
    await assert.rejects(store.setRuntime('invalid'), /Choose Electron or System WebView/);
    await assert.rejects(store.setRuntime({ runtime: 'electron' }));
    assert.deepEqual(await store.get(), { theme: 'dark', runtime: 'webview' });
    await Promise.all([store.setTheme('light'), store.setRuntime('electron')]);
    assert.deepEqual(await new SettingsStore(file).get(), { theme: 'light', runtime: 'electron' });
});

test('damaged settings are preserved when read or changed', async t => {
    const { file, store } = await fixture(t);
    for (const raw of ['{broken', '{"version":2,"theme":"dark"}', '{"version":1,"theme":"invalid"}', '{"version":1,"theme":"dark","runtime":"invalid"}']) {
        await writeFile(file, raw);
        await assert.rejects(store.get(), /preserved/);
        await assert.rejects(store.setTheme('system'), /preserved/);
        await assert.rejects(store.setRuntime('electron'), /preserved/);
        assert.equal(await readFile(file, 'utf8'), raw);
    }
});
