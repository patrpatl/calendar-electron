import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const themes = ['system', 'light', 'dark'];

export class SettingsStore {
    #file;
    #queue = Promise.resolve();

    constructor(file) { this.#file = file; }

    async #read() {
        let raw;
        try {
            raw = await readFile(this.#file, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return { theme: 'system' };
            throw new Error('Could not read your settings. Check access to the calendar data folder.');
        }
        try {
            const value = JSON.parse(raw);
            if (value.version !== 1 || !themes.includes(value.theme)) throw new Error();
            return { theme: value.theme };
        } catch {
            throw new Error('Your settings file could not be opened. It has been preserved. Restore a valid settings.json backup and try again.');
        }
    }

    #run(operation) {
        const next = this.#queue.then(operation);
        this.#queue = next.catch(() => {});
        return next;
    }

    get() { return this.#run(() => this.#read()); }

    setTheme(theme) {
        return this.#run(async () => {
            if (!themes.includes(theme)) throw new Error('Choose System, Light, or Dark.');
            await this.#read();
            await mkdir(dirname(this.#file), { recursive: true });
            await writeFile(`${this.#file}.tmp`, JSON.stringify({ version: 1, theme }, null, 2), 'utf8');
            await rename(`${this.#file}.tmp`, this.#file);
            return { theme };
        });
    }
}
