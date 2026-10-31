import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildRenderer } from '../build-renderer.js';
import { ensureNative, runSystemWebView } from '../launcher.js';

if (process.platform !== 'win32') throw new Error('The window visibility test requires Windows.');
const root = resolve(import.meta.dirname, '..');
const profile = join(root, '.test-artifacts', `visible-launch-${Date.now()}`);
await mkdir(profile, { recursive: true });
await buildRenderer(root);
await ensureNative();
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);
let verified = false;
try {
    // Use the production launch path, with no offscreen smoke-script argument.
    await runSystemWebView({
        profile, signal: controller.signal,
        async onReady({ child, send }) {
            const { stdout } = await promisify(execFile)('powershell.exe', [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                join(import.meta.dirname, 'window-state.ps1'), '-TargetProcessId', String(child.pid)
            ], { windowsHide: true });
            const window = JSON.parse(stdout);
            assert.equal(window.visible, true, 'Windows hid the Calendar window.');
            assert.equal(window.onScreen, true, 'Calendar opened offscreen.');
            assert.ok(window.width >= 760 && window.height >= 620);
            verified = true;
            console.log('PASS: A normal native launch opens a visible, onscreen Calendar window.');
            send({ kind: 'close' });
        }
    });
    assert.equal(verified, true);
} finally { clearTimeout(timeout); }
