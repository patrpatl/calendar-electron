import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { SecureStore } from '../drive/secure-store.js';

test('credentials are encrypted on disk and unavailable encryption never falls back to plaintext', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'calendar-drive-auth-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'drive-auth.bin');
    const key = randomBytes(32);
    const cipher = {
        available: async () => true,
        encrypt: async value => {
            const nonce = randomBytes(12);
            const encryptor = createCipheriv('aes-256-gcm', key, nonce);
            const data = Buffer.concat([encryptor.update(value, 'utf8'), encryptor.final()]);
            return Buffer.concat([nonce, encryptor.getAuthTag(), data]);
        },
        decrypt: async value => {
            const decryptor = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
            decryptor.setAuthTag(value.subarray(12, 28));
            return Buffer.concat([decryptor.update(value.subarray(28)), decryptor.final()]).toString('utf8');
        }
    };
    const store = new SecureStore(file, cipher);
    assert.equal(await store.read(), null);
    const value = { refreshToken: 'refresh-secret', clientSecret: 'desktop-secret' };
    await store.write(value);
    const saved = await readFile(file);
    assert.equal(saved.includes(Buffer.from('refresh-secret')), false);
    assert.equal(saved.includes(Buffer.from('desktop-secret')), false);
    assert.deepEqual(await new SecureStore(file, cipher).read(), value);
    const locked = new SecureStore(file, { ...cipher, available: async () => false });
    await assert.rejects(locked.write({}), /unavailable/);
    await assert.rejects(locked.read(), /unavailable/);
    assert.deepEqual(await readFile(file), saved);
});
