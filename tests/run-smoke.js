import { spawn } from 'node:child_process';
import electron from 'electron';
import { fileURLToPath } from 'node:url';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [fileURLToPath(new URL('./electron-smoke.cjs', import.meta.url))], {
    env, stdio: 'inherit', windowsHide: true
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
