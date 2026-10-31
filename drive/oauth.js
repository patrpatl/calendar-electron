import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { request, readJson } from './http.js';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export function parseCredentials(value) {
    const client = value?.installed;
    if (!client || typeof client.client_id !== 'string' || client.client_id.length > 512 || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(client.client_id) ||
        (client.client_secret !== undefined && (typeof client.client_secret !== 'string' || client.client_secret.length > 512))) {
        throw new Error('Import the JSON for a Google OAuth Desktop app client, not a web client or service account.');
    }
    // Endpoints from imported files are deliberately ignored.
    return { client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}) };
}

export function parseTokens(value, previousRefreshToken) {
    if (!value || typeof value.access_token !== 'string' || !value.access_token || !Number.isFinite(Number(value.expires_in)) || Number(value.expires_in) <= 0 || value.token_type?.toLowerCase() !== 'bearer') {
        throw new Error('Google did not return usable credentials. Please connect again.');
    }
    if (value.scope && !value.scope.split(' ').includes(DRIVE_SCOPE)) throw new Error('Google Drive backup access was not granted. Connect again and allow the requested permission.');
    const refreshToken = value.refresh_token || previousRefreshToken;
    if (typeof refreshToken !== 'string' || !refreshToken) throw new Error('Google did not grant offline access. Please connect again.');
    return { accessToken: value.access_token, refreshToken, expiresAt: Date.now() + Number(value.expires_in) * 1000 };
}

export async function authorize(client, { openExternal, fetcher = fetch, signal, timeoutMs = 120_000 }) {
    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    let resolveCode, rejectCode, timer;
    let callbackReceived = false;
    const codePromise = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    codePromise.catch(() => {});
    const server = createServer();
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    const cancelled = () => rejectCode(new Error('Google sign-in cancelled.'));
    const close = () => { server.close(); server.closeAllConnections(); };
    try {
        if (signal?.aborted) throw new Error('Google sign-in cancelled.');
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const port = server.address().port;
        const redirect = `http://127.0.0.1:${port}/oauth/callback`;
        server.on('request', (req, res) => {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
            res.setHeader('X-Content-Type-Options', 'nosniff');
            if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${port}` || callbackReceived) { res.writeHead(400).end('Invalid request.'); return; }
            let url;
            try { url = new URL(req.url, redirect); }
            catch { res.writeHead(400).end('Invalid request.'); return; }
            if (url.pathname !== '/oauth/callback') { res.writeHead(404).end('Not found.'); return; }
            const returnedState = Buffer.from(url.searchParams.get('state') || '');
            const expectedState = Buffer.from(state);
            if (url.searchParams.getAll('state').length !== 1 || returnedState.length !== expectedState.length || !timingSafeEqual(returnedState, expectedState)) {
                res.writeHead(400).end('Invalid sign-in state. Return to Calendar and try again.'); return;
            }
            if (url.searchParams.has('error')) {
                callbackReceived = true;
                res.writeHead(200).end('Sign-in was not completed. You can return to Calendar.', () => {
                    rejectCode(new Error('Google sign-in was not completed. Your local calendar is unchanged.'));
                });
                return;
            }
            const code = url.searchParams.get('code');
            if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) { res.writeHead(400).end('Missing authorization code.'); return; }
            callbackReceived = true;
            res.writeHead(200).end('Authorization received. You can return to Calendar and close this tab.', () => resolveCode(code));
        });
        signal?.addEventListener('abort', cancelled, { once: true });
        timer = setTimeout(() => rejectCode(new Error('Google sign-in timed out. Please connect again.')), timeoutMs);
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: DRIVE_SCOPE,
            code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent select_account' }).toString();
        if (signal?.aborted) throw new Error('Google sign-in cancelled.');
        try { await openExternal(url.href); }
        catch { throw new Error('Could not open your default browser. Check your browser settings and connect again.'); }
        const code = await codePromise;
        close(); // The listener exists only while the browser is signing in.
        const body = new URLSearchParams({ ...client, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect });
        const response = await request(fetcher, TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal });
        if (!response.ok) { await response.body?.cancel(); throw new Error('Google could not finish sign-in. Check your Desktop OAuth client and try again.'); }
        return parseTokens(await readJson(response));
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancelled);
        close();
    }
}
