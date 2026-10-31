import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';

const value = { title: 'A plan', date: '2026-10-30', allDay: true, start: '', end: '', color: 'teal', notes: '' };

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'calendar-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'events.json');
    return { file, store: new EventStore(file) };
}

test('create, reopen, update, and delete persist to disk', async t => {
    const { file, store } = await fixture(t);
    assert.deepEqual(await store.list(), []);
    const [event] = await store.save(value);
    assert.ok(event.id);
    const reopened = new EventStore(file);
    assert.deepEqual(await reopened.list(), [event]);
    const [updated] = await reopened.save({ ...event, title: 'Changed plan' });
    assert.equal(updated.id, event.id);
    assert.equal(updated.title, 'Changed plan');
    assert.deepEqual(await reopened.delete(event.id), []);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, events: [] });
});

test('concurrent writes do not lose events and failed operations do not block later writes', async t => {
    const { store } = await fixture(t);
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.save({ ...value, title: `Event ${index}` })));
    assert.equal((await store.list()).length, 12);
    await assert.rejects(store.save({ ...value, title: '' }));
    await assert.rejects(store.save({ ...value, id: 'missing' }));
    await assert.rejects(store.delete('missing'));
    assert.equal((await store.save({ ...value, title: 'Still works' })).length, 13);
});

test('damaged data is reported and never overwritten', async t => {
    const { file, store } = await fixture(t);
    for (const raw of ['{broken', '{"version":2,"events":[]}', '{"version":1,"events":[{}]}']) {
        await writeFile(file, raw);
        await assert.rejects(store.list(), /preserved/);
        await assert.rejects(store.save(value), /preserved/);
        assert.equal(await readFile(file, 'utf8'), raw);
    }
});

test('duplicate IDs are rejected rather than updating the wrong event', async t => {
    const { file, store } = await fixture(t);
    await writeFile(file, JSON.stringify({ version: 1, events: [{ ...value, id: 'same' }, { ...value, id: 'same' }] }));
    await assert.rejects(store.list(), /preserved/);
});
