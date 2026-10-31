const $ = id => document.getElementById(id);
const dialog = $('settings-dialog');
const controls = $('theme-options');
let busy = false;
let selectedTheme = 'system';

function reflect(settings) {
    selectedTheme = settings.theme;
    for (const input of controls.querySelectorAll('input')) input.checked = input.value === selectedTheme;
}

function setBusy(value) {
    busy = value;
    controls.disabled = value;
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
controls.addEventListener('change', async event => {
    const theme = event.target.value;
    if (busy || theme === selectedTheme) return;
    setBusy(true);
    $('settings-error').hidden = true;
    $('settings-status').textContent = 'Saving your theme…';
    try {
        const result = await window.settingsAPI.setTheme(theme);
        if (!result.ok) throw new Error(result.error);
        reflect(result.settings);
        $('settings-status').textContent = 'Theme saved.';
    } catch (error) {
        reflect({ theme: selectedTheme });
        showError(error);
    } finally {
        setBusy(false);
        controls.querySelector('input:checked')?.focus();
    }
});
window.settingsAPI?.onChanged(reflect);
