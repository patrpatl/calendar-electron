import { createServer, connect } from 'node:net';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// A kernel-owned pipe prevents Electron and WebView from writing the same
// profile concurrently. Unlike a lock file, it disappears after a crash.
export async function acquireHostLock(profile, focus) {
    const key = createHash('sha256').update(resolve(profile).toLowerCase()).digest('hex').slice(0, 24);
    const address = `\\\\.\\pipe\\calendar-${key}`;
    const server = createServer(socket => {
        socket.on('error', () => {});
        socket.end();
        focus();
    });
    try {
        await new Promise((resolveLock, reject) => {
            server.once('error', reject);
            server.listen(address, resolveLock);
        });
    } catch (error) {
        if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
        await new Promise((resolveFocus, reject) => {
            const socket = connect(address);
            socket.once('connect', () => socket.end());
            socket.once('end', resolveFocus);
            socket.once('error', reject);
        });
        return null;
    }
    return () => new Promise(resolveClose => server.close(resolveClose));
}
