import { spawn } from 'node:child_process';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { buildRenderer } from './build-renderer.js';
import { acquireHostLock } from './host-lock.js';
import { createDesktopServices } from './desktop-services.js';
import { windowsCipher } from './native/windows-cipher.js';
import { SettingsStore } from './settings-store.js';

const root = import.meta.dirname;

export async function preferredRuntime(profile, { platform = process.platform, forceElectron = false, warn = console.warn } = {}) {
    if (forceElectron || platform !== 'win32') return 'electron';
    try { return (await new SettingsStore(join(profile, 'settings.json')).get()).runtime; }
    catch (error) {
        // Keep startup usable and preserve the file. Settings displays the read error.
        warn(`Calendar settings: ${error.message} Opening with Electron.`);
        return 'electron';
    }
}

export async function ensureNative() {
    const directory = join(root, 'native');
    const hash = createHash('sha256');
    for (const file of ['CalendarHost.cs', 'build.ps1', 'CalendarWebView.exe.config']) hash.update(await readFile(join(directory, file)));
    const fingerprint = hash.digest('hex');
    const stamp = join(directory, 'bin', '.build-hash');
    try {
        if ((await readFile(stamp, 'utf8')) === fingerprint) {
            await Promise.all(['CalendarWebView.exe', 'CalendarWebView.exe.config', 'Microsoft.Web.WebView2.Core.dll', `${process.arch === 'ia32' ? 'x86' : process.arch}/WebView2Loader.dll`].map(file => access(join(directory, 'bin', file))));
            return;
        }
    } catch {}
    await new Promise((resolveBuild, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(directory, 'build.ps1')], { stdio: 'inherit', windowsHide: true });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolveBuild() : reject(new Error('The system WebView host could not be built.')));
    });
    await writeFile(stamp, fingerprint, 'utf8');
}

// Injectable process creation keeps fallback and timeout tests independent of GUI.
export async function chooseHost({ system, electron, warn = console.warn }) {
    try { return await system(); }
    catch (error) {
        if (error.name === 'AbortError') return 0;
        warn(`System WebView unavailable: ${error.message}\nOpening Calendar with Electron.`);
        return electron();
    }
}

export function runSystemWebView({ profile, smokeScript, onSmokeResult, onReady, signal, startupTimeout = 15_000, spawnHost = spawn, setFocus = () => {} }) {
    return new Promise((resolveRun, rejectRun) => {
        const args = [root, profile, ...(smokeScript ? [smokeScript] : [])];
        // SW_HIDE also hides a WinForms app's first window. Only offscreen test
        // hosts should inherit it; the normal GUI must be launched visibly.
        const child = spawnHost(join(root, 'native', 'bin', 'CalendarWebView.exe'), args, { windowsHide: Boolean(smokeScript), stdio: ['pipe', 'pipe', 'pipe'] });
        const pending = new Map();
        const active = new Set();
        let sequence = 0;
        let ready = false;
        let userClosed = false;
        let failure;
        let finished = false;
        let stopping = false;
        let killTimer;
        const send = message => {
            if (!child.stdin.destroyed && !stopping) child.stdin.write(`${JSON.stringify(message)}\n`);
        };
        setFocus(() => send({ kind: 'focus' }));
        const host = (action, value) => new Promise((resolveRequest, reject) => {
            if (stopping || finished) { reject(new Error('The system WebView has closed.')); return; }
            const id = ++sequence;
            pending.set(id, { resolve: resolveRequest, reject });
            send({ kind: 'native', id, action, value });
        });
        const services = createDesktopServices(profile, host, windowsCipher(profile, host));
        const stop = error => {
            if (stopping || finished) return;
            failure = error;
            services.cancel();
            send({ kind: 'quit' });
            stopping = true;
            killTimer = setTimeout(() => child.kill(), 2000);
        };
        const abort = () => stop(new DOMException('Launch cancelled.', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => stop(new Error('The system WebView did not finish starting in time.')), startupTimeout);
        const track = promise => {
            active.add(promise);
            promise.catch(stop).finally(() => active.delete(promise));
        };
        child.stdin.on('error', stop);
        child.stderr.on('data', value => process.stderr.write(value));
        const lines = createInterface({ input: child.stdout });
        lines.on('line', line => {
            try {
                const message = JSON.parse(line);
                if (message.kind === 'native-result') {
                    const request = pending.get(message.id);
                    if (request) {
                        pending.delete(message.id);
                        if (message.ok) request.resolve(message.result);
                        else request.reject(new Error(message.error));
                    }
                } else if (message.kind === 'invoke') {
                    track((async () => {
                        const result = await services.invoke(message.channel, message.value);
                        send({ kind: 'result', id: message.id, result });
                        if (['settings:set-theme', 'settings:set-runtime'].includes(message.channel) && result.ok) send({ kind: 'event', name: 'settings:changed', value: result.settings });
                    })());
                } else if (message.kind === 'ready') {
                    if (!ready) {
                        ready = true;
                        clearTimeout(timer);
                        if (onReady) track(Promise.resolve(onReady({ child, host, send })));
                    }
                } else if (message.kind === 'user-close') { userClosed = true; clearTimeout(timer); }
                else if (message.kind === 'fatal') stop(new Error(message.error));
                else if (message.kind === 'trace') console.log(`WebView startup: ${message.stage}: ${message.milliseconds} ms`);
                else if (message.kind === 'smoke-result' && onSmokeResult) track(Promise.resolve(onSmokeResult(message, { child, host, send })));
            } catch (error) { stop(error); }
        });
        child.once('error', error => { failure = error; });
        child.once('close', async (code, exitSignal) => {
            finished = true;
            stopping = true;
            clearTimeout(timer);
            clearTimeout(killTimer);
            signal?.removeEventListener('abort', abort);
            lines.close();
            services.cancel();
            for (const request of pending.values()) request.reject(new Error('The system WebView has closed.'));
            pending.clear();
            // Finish in-flight atomic writes before letting Electron take ownership.
            await Promise.allSettled([...active]);
            setFocus(() => {});
            if (failure) rejectRun(failure);
            else if (code !== 0 || exitSignal || (!ready && !userClosed)) rejectRun(new Error(`The system WebView exited before closing normally (${exitSignal || code}).`));
            else resolveRun(0);
        });
        track(services.settings.get().catch(() => ({ theme: 'system' })).then(settings => host('theme', settings.theme)));
        if (signal?.aborted) abort();
    });
}

async function runElectron(signal) {
    const { default: electron } = await import('electron');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    return new Promise((resolveRun, reject) => {
        const child = spawn(electron, [root], { env, stdio: 'inherit', windowsHide: false });
        const abort = () => child.kill();
        signal.addEventListener('abort', abort, { once: true });
        child.once('error', reject);
        child.once('exit', code => { signal.removeEventListener('abort', abort); resolveRun(code ?? 1); });
        if (signal.aborted) abort();
    });
}

async function main() {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    let release;
    try {
        let focus = () => {};
        const profile = process.platform === 'win32' ? join(process.env.APPDATA, 'calendar') : null;
        const runtime = await preferredRuntime(profile, { forceElectron: process.argv.includes('--electron') });
        if (runtime === 'webview') {
            release = await acquireHostLock(profile, () => focus());
            if (!release) return;
            await buildRenderer(root);
            const code = await chooseHost({
                system: async () => {
                    await ensureNative();
                    if (controller.signal.aborted) throw new DOMException('Launch cancelled.', 'AbortError');
                    return runSystemWebView({ profile, signal: controller.signal, setFocus: callback => { focus = callback; } });
                },
                electron: async () => { await release(); release = null; return runElectron(controller.signal); }
            });
            process.exitCode = code;
        } else {
            await buildRenderer(root);
            process.exitCode = await runElectron(controller.signal);
        }
    } finally {
        if (release) await release();
        process.removeListener('SIGINT', abort);
        process.removeListener('SIGTERM', abort);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
