const $ = id => document.getElementById(id);
let state = null;
let pending = null;
let message = '';

function render() {
    const busy = Boolean(pending || state?.busy);
    const connecting = pending === 'connect' || state?.connecting;
    $('drive-import').disabled = busy || Boolean(state?.connected);
    $('drive-import').textContent = state?.configured ? 'Change OAuth JSON' : 'Import OAuth JSON';
    $('drive-connect').hidden = Boolean(state?.connected) || Boolean(connecting);
    $('drive-connect').disabled = busy || !state?.configured;
    $('drive-cancel').hidden = !connecting;
    $('drive-backup-actions').hidden = !state?.connected;
    for (const id of ['drive-upload', 'drive-restore', 'drive-disconnect']) $(id).disabled = busy;
    $('drive-account').hidden = !state?.account;
    $('drive-account').textContent = state?.account || '';
    $('drive-badge').textContent = state?.connected ? 'Connected' : 'Optional';
    $('drive-status').textContent = message || (state?.connected ? 'Ready to back up or restore your events.' : state?.configured ? 'OAuth client imported. Connect your Google account.' : 'Import a Desktop OAuth client to get started.');
}

async function refresh() {
    if (!window.driveAPI) throw new Error('Open Calendar with npm start to use Google Drive.');
    const result = await window.driveAPI.status();
    if (!result.ok) throw new Error(result.error);
    state = result.status;
    render();
}

function showError(error) {
    $('drive-error').textContent = error.message;
    $('drive-error').hidden = false;
}

async function load() {
    $('drive-error').hidden = true;
    $('drive-retry').hidden = true;
    try { await refresh(); }
    catch (error) { showError(error); $('drive-retry').hidden = false; }
}

async function perform(method) {
    if (pending) return;
    pending = method;
    $('drive-error').hidden = true;
    message = { importClient: 'Choose your Desktop OAuth client JSON…', connect: 'Complete sign-in in your browser…', upload: 'Uploading a new backup…', restore: 'Retrieving your latest backup…', disconnect: 'Disconnecting Google Drive…' }[method];
    render();
    try {
        const result = await window.driveAPI[method]();
        if (!result.ok) throw new Error(result.error);
        state = result.status;
        if (result.cancelled) message = method === 'restore' ? 'Restore cancelled. Your local events are unchanged.' : 'No OAuth client selected.';
        else if (method === 'upload') message = `Backed up ${result.count} event${result.count === 1 ? '' : 's'} to Drive.`;
        else if (method === 'restore') {
            message = `Restored ${result.count} event${result.count === 1 ? '' : 's'}. Your previous events were saved locally.`;
            window.dispatchEvent(new Event('calendar-restored'));
        } else message = { importClient: 'OAuth client imported. You can now connect.', connect: 'Connected. You can upload or restore a backup.', disconnect: 'Disconnected. Your local events are unchanged.' }[method];
    } catch (error) {
        if (error.message === 'Google sign-in cancelled.') message = 'Sign-in cancelled.';
        else { message = 'The action could not be completed.'; showError(error); }
        await refresh().catch(() => {});
    } finally {
        pending = null;
        render();
    }
}

$('open-settings').addEventListener('click', load);
$('drive-retry').addEventListener('click', load);
for (const [id, method] of [['drive-import', 'importClient'], ['drive-connect', 'connect'], ['drive-upload', 'upload'], ['drive-restore', 'restore'], ['drive-disconnect', 'disconnect']]) {
    $(id).addEventListener('click', () => perform(method));
}
$('drive-cancel').addEventListener('click', async () => {
    $('drive-cancel').disabled = true;
    try { await window.driveAPI.cancelConnect(); }
    catch (error) { showError(error); }
    finally { $('drive-cancel').disabled = false; }
});
