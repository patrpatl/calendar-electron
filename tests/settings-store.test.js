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

test('settings default to system and a saved theme survives reopening', async t => {
    const { file, store } = await fixture(t);
    assert.deepEqual(await store.get(), { theme: 'system' });
    await store.setTheme('dark');
    assert.deepEqual(await new SettingsStore(file).get(), { theme: 'dark' });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, theme: 'dark' });
    await store.setTheme('light');
    await store.setTheme('system');
    assert.deepEqual(await new SettingsStore(file).get(), { theme: 'system' });
});

test('invalid settings never replace a saved theme, and writes retain their order', async t => {
    const { store } = await fixture(t);
    await store.setTheme('light');
    await assert.rejects(store.setTheme('invalid'));
    await assert.rejects(store.setTheme({ theme: 'dark' }));
    assert.deepEqual(await store.get(), { theme: 'light' });
    await Promise.all([store.setTheme('dark'), store.setTheme('system'), store.setTheme('light')]);
    assert.deepEqual(await store.get(), { theme: 'light' });
});

test('damaged settings are preserved when read or changed', async t => {
    const { file, store } = await fixture(t);
    for (const raw of ['{broken', '{"version":2,"theme":"dark"}', '{"version":1,"theme":"invalid"}']) {
        await writeFile(file, raw);
        await assert.rejects(store.get(), /preserved/);
        await assert.rejects(store.setTheme('system'), /preserved/);
        assert.equal(await readFile(file, 'utf8'), raw);
    }
});
