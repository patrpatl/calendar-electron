import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { authorize, DRIVE_SCOPE, parseCredentials, TOKEN_ENDPOINT } from '../drive/oauth.js';

const client = { client_id: '123-test.apps.googleusercontent.com', client_secret: 'desktop-secret' };
const tokenResponse = () => new Response(JSON.stringify({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, token_type: 'Bearer', scope: DRIVE_SCOPE }));

test('only Desktop OAuth JSON is accepted; imported endpoints are ignored', () => {
    assert.deepEqual(parseCredentials({ installed: { ...client, token_uri: 'https://untrusted.invalid' } }), client);
    assert.throws(() => parseCredentials({ web: client }), /Desktop/);
    assert.throws(() => parseCredentials({ installed: { client_id: 'not-google' } }));
});

test('OAuth uses loopback, state, S256 PKCE, offline access, and closes its listener', async () => {
    let auth, redirect;
    const tokens = await authorize(client, {
        openExternal: async value => {
            auth = new URL(value);
            assert.equal(auth.origin, 'https://accounts.google.com');
            assert.equal(auth.searchParams.get('scope'), DRIVE_SCOPE);
            assert.equal(auth.searchParams.get('access_type'), 'offline');
            assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
            assert.equal(auth.searchParams.has('client_secret'), false);
            redirect = auth.searchParams.get('redirect_uri');
            assert.equal(new URL(redirect).hostname, '127.0.0.1');
            const wrong = new URL(redirect);
            wrong.search = new URLSearchParams({ code: 'test-code', state: 'wrong-state' }).toString();
            assert.equal((await fetch(wrong)).status, 400);
            const callback = new URL(redirect);
            callback.search = new URLSearchParams({ code: 'test-code', state: auth.searchParams.get('state') }).toString();
            const response = await fetch(callback);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.match(await response.text(), /return to Calendar/);
        },
        fetcher: async (url, options) => {
            assert.equal(url, TOKEN_ENDPOINT);
            assert.equal(options.method, 'POST');
            const body = options.body;
            assert.equal(body.get('code'), 'test-code');
            assert.equal(body.get('redirect_uri'), redirect);
            assert.equal(body.get('client_secret'), client.client_secret);
            assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), auth.searchParams.get('code_challenge'));
            return tokenResponse();
        }
    });
    assert.equal(tokens.refreshToken, 'test-refresh');
    await assert.rejects(fetch(redirect, { signal: AbortSignal.timeout(500) }));
});

test('cancel and timeout close the OAuth callback listener', async () => {
    for (const mode of ['cancel', 'timeout']) {
        const controller = new AbortController();
        let redirect;
        await assert.rejects(authorize(client, {
            signal: controller.signal, timeoutMs: 25,
            openExternal: async value => { redirect = new URL(value).searchParams.get('redirect_uri'); if (mode === 'cancel') controller.abort(); },
            fetcher: async () => { throw new Error('Token exchange must not run.'); }
        }), mode === 'cancel' ? /cancelled/ : /timed out/);
        await assert.rejects(fetch(redirect, { signal: AbortSignal.timeout(500) }));
    }
});

test('declined consent and token exchange failure do not leave a listener running', async () => {
    for (const mode of ['denied', 'token-error']) {
        let redirect;
        await assert.rejects(authorize(client, {
            openExternal: async value => {
                const auth = new URL(value);
                redirect = auth.searchParams.get('redirect_uri');
                const callback = new URL(redirect);
                callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), ...(mode === 'denied' ? { error: 'access_denied' } : { code: 'test-code' }) });
                await (await fetch(callback)).text();
            },
            fetcher: async () => new Response('{"error":"invalid_grant"}', { status: 400 })
        }), mode === 'denied' ? /not completed/ : /could not finish/);
        await assert.rejects(fetch(redirect, { signal: AbortSignal.timeout(500) }));
    }
});
