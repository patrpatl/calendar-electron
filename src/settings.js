const $ = id => document.getElementById(id);
const dialog = $('settings-dialog');
const controls = $('theme-options');
const runtimeControls = $('runtime-options');
let busy = false;
let selected = { theme: 'system', runtime: 'electron' };

if (window.settingsAPI?.supportsSystemWebView === false) {
    runtimeControls.querySelector('[value="webview"]').disabled = true;
    $('runtime-note').textContent = 'System WebView is available on Windows.';
}

function reflect(settings) {
    selected = settings;
    for (const input of controls.querySelectorAll('input')) input.checked = input.value === selected.theme;
    for (const input of runtimeControls.querySelectorAll('input')) input.checked = input.value === selected.runtime;
}

function setBusy(value) {
    busy = value;
    controls.disabled = value;
    runtimeControls.disabled = value;
    for (const id of ['close-settings', 'done-settings', 'retry-settings']) $(id).disabled = value;
    dialog.setAttribute('aria-busy', String(value));
}

function showError(error) {
    $('settings-error-text').textContent = error.message;
    $('settings-error').hidden = false;
    $('settings-status').textContent = 'Preferences could not be saved.';
}

async function load() {
    setBusy(true);
    $('settings-error').hidden = true;
    $('settings-status').textContent = 'Loading your preferences…';
    let loaded = false;
    try {
        if (!window.settingsAPI) throw new Error('Open Calendar with npm start to change your settings.');
        const result = await window.settingsAPI.get();
        if (!result.ok) throw new Error(result.error);
        reflect(result.settings);
        $('settings-status').textContent = 'Changes are saved automatically.';
        loaded = true;
    } catch (error) {
        showError(error);
    } finally {
        setBusy(false);
        controls.disabled = !loaded;
        runtimeControls.disabled = !loaded;
    }
}

$('open-settings').addEventListener('click', () => {
    dialog.showModal();
    load();
});
for (const id of ['close-settings', 'done-settings']) $(id).addEventListener('click', () => { if (!busy) dialog.close(); });
dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
dialog.addEventListener('close', () => $('open-settings').focus());
$('retry-settings').addEventListener('click', load);
async function savePreference(key, value) {
    if (busy || value === selected[key]) return;
    setBusy(true);
    $('settings-error').hidden = true;
    $('settings-status').textContent = key === 'theme' ? 'Saving your theme…' : 'Saving your app engine…';
    try {
        const result = await window.settingsAPI[key === 'theme' ? 'setTheme' : 'setRuntime'](value);
        if (!result.ok) throw new Error(result.error);
        reflect(result.settings);
        $('settings-status').textContent = key === 'theme' ? 'Theme saved.' : 'App engine saved. Reopen Calendar to apply it.';
    } catch (error) {
        reflect(selected);
        showError(error);
    } finally {
        setBusy(false);
        (key === 'theme' ? controls : runtimeControls).querySelector('input:checked')?.focus();
    }
}
controls.addEventListener('change', event => savePreference('theme', event.target.value));
runtimeControls.addEventListener('change', event => savePreference('runtime', event.target.value));
window.settingsAPI?.onChanged(reflect);
