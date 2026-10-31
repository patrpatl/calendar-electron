import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeEvent, sortEvents } from './src/calendar.js';
import { validateEvents } from './drive/backup.js';

export class EventStore {
    #file;
    #queue = Promise.resolve();

    constructor(file) { this.#file = file; }

    async #read() {
        let raw;
        try {
            raw = await readFile(this.#file, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw new Error('Could not read your events. Check access to the calendar data folder.');
        }
        try {
            const data = JSON.parse(raw);
            if (data.version !== 1 || !Array.isArray(data.events)) throw new Error();
            const ids = new Set();
            return data.events.map(event => {
                if (typeof event.id !== 'string' || !event.id || ids.has(event.id)) throw new Error();
                ids.add(event.id);
                return { id: event.id, ...normalizeEvent(event) };
            });
        } catch {
            // Preserve the original file instead of silently replacing damaged data.
            throw new Error('Your events file could not be opened. It has been preserved; restore a valid events.json backup in the calendar data folder.');
        }
    }

    #run(operation) {
        const next = this.#queue.then(operation);
        this.#queue = next.catch(() => {});
        return next;
    }

    async #write(events) {
        await mkdir(dirname(this.#file), { recursive: true });
        const temporary = `${this.#file}.tmp`;
        await writeFile(temporary, JSON.stringify({ version: 1, events }, null, 2), 'utf8');
        await rename(temporary, this.#file);
    }

    list() { return this.#run(async () => sortEvents(await this.#read())); }

    save(value) {
        return this.saveRecord(value).then(result => result.events);
    }

    saveRecord(value) {
        return this.#run(async () => {
            const normalized = normalizeEvent(value);
            const events = await this.#read();
            const editing = value.id !== undefined && value.id !== null;
            const index = editing ? events.findIndex(event => event.id === value.id) : -1;
            if (editing && index < 0) throw new Error('This event no longer exists. Reopen the calendar and try again.');
            const event = { id: editing ? value.id : randomUUID(), ...normalized };
            if (editing) events[index] = event;
            else events.push(event);
            await this.#write(events);
            return { events: sortEvents(events), savedId: event.id };
        });
    }

    delete(id) {
        return this.#run(async () => {
            const events = await this.#read();
            if (!events.some(event => event.id === id)) throw new Error('This event no longer exists.');
            const remaining = events.filter(event => event.id !== id);
            await this.#write(remaining);
            return sortEvents(remaining);
        });
    }

    restore(events) {
        return this.#run(async () => {
            const validated = sortEvents(validateEvents(events));
            const current = await this.#read();
            const backups = join(dirname(this.#file), 'backups');
            await mkdir(backups, { recursive: true });
            const file = join(backups, `before-drive-restore-${Date.now()}-${randomUUID()}.json`);
            await writeFile(file, JSON.stringify({ version: 1, events: current }, null, 2), { flag: 'wx' });
            await this.#write(validated);
            return validated;
        });
    }
}
