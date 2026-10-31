export async function request(fetcher, url, options = {}) {
    const timeout = AbortSignal.timeout(30_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
        return await fetcher(url, { ...options, signal, redirect: 'error' });
    } catch (error) {
        if (options.signal?.aborted) throw new Error('Google sign-in cancelled.');
        if (signal.aborted) throw new Error('Google did not respond in time. Please try again.');
        // Never forward request bodies, authorization headers, or raw API errors.
        throw new Error('Could not reach Google. Check your connection and try again.');
    }
}

export async function readJson(response, maximum = 64 * 1024) {
    if (Number(response.headers.get('content-length')) > maximum) {
        await response.body?.cancel();
        throw new Error('Google returned a file that exceeds the allowed size.');
    }
    const parts = [];
    let bytes = 0;
    if (response.body) {
        const reader = response.body.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > maximum) throw new Error('Google returned a file that exceeds the allowed size.');
                parts.push(Buffer.from(value));
            }
        } catch (error) {
            await reader.cancel().catch(() => {});
            throw error;
        } finally { reader.releaseLock(); }
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw new Error('Google returned invalid data. Please try again.'); }
}
