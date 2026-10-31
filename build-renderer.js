import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function rendererFingerprint(root) {
    const hash = createHash('sha256');
    async function visit(path) {
        for (const entry of (await readdir(join(root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const relative = join(path, entry.name);
            if (entry.isDirectory()) await visit(relative);
            else { hash.update(relative); hash.update(await readFile(join(root, relative))); }
        }
    }
    await visit('src');
    for (const file of ['package.json', 'package-lock.json', 'vite.config.mjs', 'build-renderer.js']) {
        hash.update(await readFile(join(root, file)));
    }
    return hash.digest('hex');
}

export async function buildRenderer(root = import.meta.dirname, { force = false } = {}) {
    const fingerprint = await rendererFingerprint(root);
    const stamp = join(root, 'dist', '.build-hash');
    if (!force) {
        try {
            if ((await readFile(stamp, 'utf8')) === fingerprint) {
                const html = await readFile(join(root, 'dist', 'index.html'), 'utf8');
                // Rebuild if a generated asset has been removed or dist is incomplete.
                const assets = [...html.matchAll(/(?:src|href)="\.\/([^"?#]+)"/g)];
                await Promise.all(assets.map(([, file]) => readFile(join(root, 'dist', file))));
                return false;
            }
        } catch {}
    }
    const { build } = await import('vite');
    await build({ configFile: join(root, 'vite.config.mjs') });
    await writeFile(stamp, fingerprint, 'utf8');
    return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await buildRenderer(import.meta.dirname, { force: true });
}
