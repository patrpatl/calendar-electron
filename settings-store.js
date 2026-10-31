import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const themes = ['system', 'light', 'dark'];
const runtimes = ['electron', 'webview'];

export class SettingsStore {
    #file;
    #queue = Promise.resolve();

    constructor(file) { this.#file = file; }

    async #read() {
        let raw;
        try {
            raw = await readFile(this.#file, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return { theme: 'system', runtime: 'electron' };
            throw new Error('Could not read your settings. Check access to the calendar data folder.');
        }
        try {
            const value = JSON.parse(raw);
            if (value.version !== 1 || !themes.includes(value.theme) || (value.runtime !== undefined && !runtimes.includes(value.runtime))) throw new Error();
            return { theme: value.theme, runtime: value.runtime ?? 'electron' };
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
        return this.#set('theme', theme, themes, 'Choose System, Light, or Dark.');
    }

    setRuntime(runtime) {
        return this.#set('runtime', runtime, runtimes, 'Choose Electron or System WebView.');
    }

    #set(key, value, allowed, message) {
        return this.#run(async () => {
            if (!allowed.includes(value)) throw new Error(message);
            const settings = { ...await this.#read(), [key]: value };
            await mkdir(dirname(this.#file), { recursive: true });
            await writeFile(`${this.#file}.tmp`, JSON.stringify({ version: 1, ...settings }, null, 2), 'utf8');
            await rename(`${this.#file}.tmp`, this.#file);
            return settings;
        });
    }
}
