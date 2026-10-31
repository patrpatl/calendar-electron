import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// Electron/Chromium's Windows safeStorage format: v10 + nonce + AES-GCM
// ciphertext + tag. The key in Local State is protected by the user's DPAPI.
// Keep one credential file so switching hosts never loses the Google sign-in.
export function windowsCipher(profile, host) {
    let keyPromise;
    async function loadKey() {
        const file = join(profile, 'Local State');
        let state;
        try { state = JSON.parse(await readFile(file, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; state = {}; }
        let key;
        if (state.os_crypt?.encrypted_key) {
            const wrapped = Buffer.from(state.os_crypt.encrypted_key, 'base64');
            if (wrapped.subarray(0, 5).toString() !== 'DPAPI') throw new Error('Unsupported Windows credential key.');
            key = Buffer.from(await host('unprotect', wrapped.subarray(5).toString('base64')), 'base64');
        } else {
            key = randomBytes(32);
            const protectedKey = Buffer.from(await host('protect', key.toString('base64')), 'base64');
            state.os_crypt = { ...state.os_crypt, encrypted_key: Buffer.concat([Buffer.from('DPAPI'), protectedKey]).toString('base64') };
            await mkdir(profile, { recursive: true });
            await writeFile(`${file}.tmp`, JSON.stringify(state), 'utf8');
            await rename(`${file}.tmp`, file);
        }
        if (key.length !== 32) throw new Error('Invalid Windows credential key.');
        return key;
    }
    function getKey() {
        return keyPromise ??= loadKey().catch(error => { keyPromise = null; throw error; });
    }
    return {
        available: async () => { try { await getKey(); return true; } catch { return false; } },
        async encrypt(value) {
            const nonce = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', await getKey(), nonce);
            return Buffer.concat([Buffer.from('v10'), nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
        },
        async decrypt(value) {
            if (value.length < 31 || value.subarray(0, 3).toString() !== 'v10') throw new Error('Unsupported Windows credential format.');
            const decipher = createDecipheriv('aes-256-gcm', await getKey(), value.subarray(3, 15));
            decipher.setAuthTag(value.subarray(-16));
            return Buffer.concat([decipher.update(value.subarray(15, -16)), decipher.final()]).toString('utf8');
        }
    };
}
