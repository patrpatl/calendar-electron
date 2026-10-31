// Both desktop hosts update this media query when the theme changes.
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');

function syncTheme() {
    document.documentElement.dataset.bsTheme = systemTheme.matches ? 'dark' : 'light';
}

syncTheme();
systemTheme.addEventListener('change', syncTheme);
window.addEventListener('focus', syncTheme);
