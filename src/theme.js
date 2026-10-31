// Electron's system theme updates this media query without an IPC bridge.
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');

function syncTheme() {
    document.documentElement.dataset.bsTheme = systemTheme.matches ? 'dark' : 'light';
}

syncTheme();
systemTheme.addEventListener('change', syncTheme);
window.addEventListener('focus', syncTheme);
