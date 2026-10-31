import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export class SecureStore {
    constructor(file, cipher) { this.file = file; this.cipher = cipher; }

    async read() {
        let encrypted;
        try { encrypted = await readFile(this.file); }
        catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Could not read your saved Google connection.'); }
        if (!(await this.cipher.available())) throw new Error('Secure credential storage is unavailable. Unlock your system keyring and try again.');
        try { return JSON.parse(await this.cipher.decrypt(encrypted)); }
        catch { throw new Error('Your saved Google connection could not be decrypted. Your calendar events have not changed.'); }
    }

    async write(value) {
        if (!(await this.cipher.available())) throw new Error('Secure credential storage is unavailable. Unlock your system keyring and try again.');
        const encrypted = await this.cipher.encrypt(JSON.stringify(value));
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(`${this.file}.tmp`, encrypted, { mode: 0o600 });
        await rename(`${this.file}.tmp`, this.file);
    }
}
