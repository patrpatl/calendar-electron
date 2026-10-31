import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import electron from 'electron';
import { buildRenderer } from '../build-renderer.js';
import { runSystemWebView, ensureNative, chooseHost } from '../launcher.js';
import { windowsCipher } from '../native/windows-cipher.js';

if (process.platform !== 'win32') throw new Error('The system WebView smoke test requires Windows.');
if (process.argv.includes('--trace')) process.env.CALENDAR_STARTUP_TRACE = '1';
const root = resolve(import.meta.dirname, '..');
const profile = join(root, '.test-artifacts', `webview-${Date.now()}`);
await mkdir(profile, { recursive: true });
await buildRenderer(root);
await ensureNative();
async function fixture(mode) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise((resolveChild, reject) => {
        const child = spawn(electron, [join(import.meta.dirname, 'electron-cipher-fixture.cjs'), profile, mode], { env, stdio: 'inherit', windowsHide: true });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolveChild() : reject(new Error(`Electron cipher ${mode} failed (${code}).`)));
    });
}
await fixture('seed');
let tested = false;
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 45_000);
const started = performance.now();
let cipherReady;
try {
    await runSystemWebView({
        profile,
        smokeScript: join(import.meta.dirname, 'webview-smoke-renderer.js'),
        signal: controller.signal,
        onReady({ host }) {
            console.log(`PASS: System WebView rendered the calendar in ${Math.round(performance.now() - started)} ms (test profile).`);
            const cipher = windowsCipher(profile, host);
            cipherReady = (async () => {
                assert.equal(await cipher.available(), true);
                assert.equal(await cipher.decrypt(await readFile(join(profile, 'electron-cipher.bin'))), 'Electron to WebView: 日本語');
                await writeFile(join(profile, 'webview-cipher.bin'), await cipher.encrypt('WebView to Electron: 日本語'));
                console.log('PASS: WebView decrypts real Electron safeStorage credentials.');
            })();
            return cipherReady;
        },
        async onSmokeResult(message, { send }) {
            assert.equal(message.ok, true, message.error);
            await cipherReady;
            tested = true;
            console.log('PASS: WebView sandbox, event editing, persistence, themes, and optional Drive bridge.');
            send({ kind: 'close' });
        }
    });
    assert.equal(tested, true, 'Native smoke assertions did not finish.');
    const events = JSON.parse(await readFile(join(profile, 'events.json'), 'utf8')).events;
    assert.deepEqual(events.map(event => event.title).sort(), ['Persisted after WebView exit', 'Saved during window close']);
    console.log('PASS: Window close flushes the editor before the host exits.');
    await fixture('verify');
    console.log('PASS: Electron decrypts credentials written by WebView; fallback keeps the same sign-in.');
    const warmStarted = performance.now();
    await runSystemWebView({
        profile,
        smokeScript: join(import.meta.dirname, 'webview-warm-renderer.js'),
        signal: controller.signal,
        onReady: () => console.log(`PASS: Repeat system WebView startup: ${Math.round(performance.now() - warmStarted)} ms.`),
        onSmokeResult: (_message, { send }) => send({ kind: 'close' })
    });
    let fallbackCount = 0;
    await chooseHost({
        system: () => runSystemWebView({
            profile,
            smokeScript: join(import.meta.dirname, 'webview-warm-renderer.js'),
            signal: controller.signal,
            spawnHost: (file, args, options) => spawn(file, args, {
                ...options,
                env: { ...process.env, WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: join(profile, 'missing-webview-runtime') }
            })
        }),
        electron: async () => { fallbackCount++; await fixture('render'); return 0; },
        warn: message => console.log(message)
    });
    assert.equal(fallbackCount, 1);
    console.log('PASS: A real WebView runtime initialization failure automatically opens Electron.');
    assert.equal(await buildRenderer(root), false, 'Unchanged renderer was rebuilt.');
    console.log('PASS: Unchanged launches reuse the built renderer.');
} finally { clearTimeout(timeout); }
