import 'bootstrap/dist/css/bootstrap.min.css';
import './style.css';
import './theme.js';
import './settings.js';
import './drive-settings.js';
import './scrollbars.js';
import { dateKey, parseDate, monthDays, shiftMonth, isSupportedDate, normalizeEvent, sortEvents, searchEvents, MIN_YEAR, MAX_YEAR } from './calendar.js';

const $ = id => document.getElementById(id);
const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const fullDateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const shortDateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
let today = dateKey(new Date());
let selected = today;
let visible = parseDate(selected);
let events = [];
let loaded = false;
let editingId = null;
let busy = false;
let toastTimer;
let dialogOpener;
let lastDayClick = { key: null, time: 0 };
let currentPreviewLimit;

function previewLimit() { return window.innerWidth <= 860 || window.innerHeight >= 950 ? 2 : 1; }

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function plural(count) { return `${count} event${count === 1 ? '' : 's'}`; }

function formatTime(time) {
    const [hours, minutes] = time.split(':').map(Number);
    return timeFormat.format(new Date(2000, 0, 1, hours, minutes));
}

function eventTime(event) {
    if (event.allDay) return 'All day';
    return formatTime(event.start) + (event.end ? ` – ${formatTime(event.end)}` : '');
}

function notify(text) {
    $('announcement').textContent = text;
    $('toast').textContent = text;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000);
}

function selectDate(key, focus = false) {
    if (!isSupportedDate(key)) return;
    selected = key;
    visible = parseDate(key);
    $('search').value = '';
    render();
    if (focus) document.querySelector(`[data-date="${selected}"]`)?.focus();
}

function goToday() { selectDate(dateKey(new Date()), true); }

function moveMonth(offset) {
    selectDate(shiftMonth(selected, offset));
}

function renderCalendar() {
    currentPreviewLimit = previewLimit();
    const year = visible.getFullYear();
    const month = visible.getMonth();
    $('brand-day').textContent = parseDate(today).getDate();
    $('month-heading').textContent = monthFormat.format(visible);
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    $('month-picker').value = prefix;
    const monthEvents = events.filter(event => event.date.startsWith(prefix));
    $('month-summary').textContent = loaded ? (monthEvents.length ? `${plural(monthEvents.length)} planned this month` : 'A fresh month, full of possibilities.') : ($('app-error').hidden ? 'Loading your calendar…' : 'Your events could not be loaded.');
    $('previous-month').disabled = year === MIN_YEAR && month === 0;
    $('next-month').disabled = year === MAX_YEAR && month === 11;
    const grouped = new Map();
    for (const event of sortEvents(events)) {
        if (!grouped.has(event.date)) grouped.set(event.date, []);
        grouped.get(event.date).push(event);
    }
    const fragment = document.createDocumentFragment();
    const days = monthDays(year, month);
    for (let week = 0; week < 6; week++) {
        const row = element('div', 'calendar-week');
        row.setAttribute('role', 'row');
        for (const day of days.slice(week * 7, week * 7 + 7)) {
            const dayEvents = grouped.get(day.key) ?? [];
            const cell = element('div', `day-cell${day.inMonth ? '' : ' outside-month'}${day.key === selected ? ' selected' : ''}${day.key === today ? ' is-today' : ''}`);
            cell.setAttribute('role', 'gridcell');
            cell.setAttribute('aria-selected', String(day.key === selected));
            const button = element('button', 'day-select');
            button.type = 'button';
            button.dataset.date = day.key;
            button.tabIndex = day.key === selected ? 0 : -1;
            button.disabled = !isSupportedDate(day.key);
            button.setAttribute('aria-label', `${fullDateFormat.format(day.date)}${day.key === today ? ', today' : ''}, ${plural(dayEvents.length)}`);
            if (day.key === today) button.setAttribute('aria-current', 'date');
            const top = element('span', 'day-top');
            top.append(element('span', 'day-number', day.day));
            if (day.key === today) top.append(element('span', 'today-label', 'Today'));
            button.append(top);
            const previews = element('span', 'day-previews');
            for (const event of dayEvents.slice(0, currentPreviewLimit)) {
                const preview = element('span', 'event-preview', event.title);
                preview.dataset.color = event.color;
                preview.title = `${event.title} · ${eventTime(event)}`;
                previews.append(preview);
            }
            if (dayEvents.length > currentPreviewLimit) previews.append(element('span', 'more-events', `+${dayEvents.length - currentPreviewLimit} more`));
            button.append(previews);
            cell.append(button);
            row.append(cell);
        }
        fragment.append(row);
    }
    $('calendar-days').replaceChildren(fragment);
}

function eventCard(event, showDate = false) {
    const button = element('button', 'event-card');
    button.type = 'button';
    button.dataset.eventId = event.id;
    button.dataset.color = event.color;
    button.setAttribute('aria-label', `Edit ${event.title}, ${shortDateFormat.format(parseDate(event.date))}, ${eventTime(event)}`);
    const content = element('span', 'event-card-content');
    if (showDate) content.append(element('span', 'event-card-date', shortDateFormat.format(parseDate(event.date))));
    content.append(element('span', 'event-card-title', event.title));
    content.append(element('span', 'event-card-time', eventTime(event)));
    if (event.notes) content.append(element('span', 'event-card-notes', event.notes));
    button.append(content, element('span', 'event-card-arrow', '↗'));
    return button;
}

function showEvents(container, items, emptyText, showDate = false) {
    container.replaceChildren();
    if (!items.length) {
        const empty = element('div', 'empty-state');
        empty.append(element('span', 'empty-icon', '◷'), element('p', '', emptyText));
        container.append(empty);
    } else {
        container.append(...items.map(event => eventCard(event, showDate)));
    }
}

function renderAgenda() {
    const date = parseDate(selected);
    const dayEvents = sortEvents(events.filter(event => event.date === selected));
    $('selected-weekday').textContent = date.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase();
    $('selected-heading').textContent = date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
    $('selected-subtitle').textContent = selected === today ? 'A little look at your day.' : String(date.getFullYear());
    $('day-count').textContent = plural(dayEvents.length);
    showEvents($('day-events'), dayEvents, loaded ? 'Nothing planned. Leave room for something good.' : 'Loading your events…');
    const upcoming = sortEvents(events.filter(event => event.date >= today && event.date !== selected)).slice(0, 4);
    showEvents($('upcoming-events'), upcoming, 'Your next plans will appear here.', true);
    renderSearch();
}

function renderSearch() {
    const query = $('search').value.trim();
    $('day-section').hidden = Boolean(query);
    $('search-section').hidden = !query;
    if (!query) return;
    const matches = searchEvents(events, query);
    $('search-summary').textContent = `${plural(matches.length)} found across your calendar`;
    showEvents($('search-results'), matches, 'No events found. Try another name or a word from your notes.', true);
}

function render() { renderCalendar(); renderAgenda(); }

function updateTimeFields() {
    const allDay = $('event-all-day').checked;
    $('time-fields').hidden = allDay;
    $('event-start').required = !allDay;
    $('event-start').disabled = allDay;
    $('event-end').disabled = allDay;
}

function openEditor(id = null) {
    if (!loaded || busy) return;
    const event = id ? events.find(item => item.id === id) : null;
    if (id && !event) return;
    editingId = event?.id ?? null;
    dialogOpener = document.activeElement;
    $('event-form').reset();
    $('dialog-heading').textContent = event ? 'Edit event' : 'New event';
    $('event-title').value = event?.title ?? '';
    $('event-date').value = event?.date ?? selected;
    $('event-all-day').checked = event?.allDay ?? true;
    $('event-start').value = event?.start || '09:00';
    $('event-end').value = event?.end ?? '';
    $('event-notes').value = event?.notes ?? '';
    document.querySelector(`input[name="color"][value="${event?.color ?? 'teal'}"]`).checked = true;
    $('delete-event').hidden = !event;
    $('delete-confirmation').hidden = true;
    $('form-error').hidden = true;
    updateTimeFields();
    $('event-dialog').showModal();
    $('event-title').focus();
}

function closeEditor() {
    if (busy) return;
    $('event-dialog').close();
}

function formError(error) {
    $('form-error').textContent = error.message || String(error);
    $('form-error').hidden = false;
}

function setBusy(value) {
    busy = value;
    for (const control of $('event-form').elements) control.disabled = value;
    if (!value) updateTimeFields();
    $('save-event').textContent = value ? 'Saving…' : 'Save event';
}

async function callStorage(method, value) {
    if (!window.calendarAPI) throw new Error('Open Calendar with npm start to access your saved events.');
    const result = await window.calendarAPI[method](value);
    if (!result.ok) throw new Error(result.error);
    return result.events;
}

async function saveEvent(event) {
    event.preventDefault();
    if (busy) return;
    $('form-error').hidden = true;
    try {
        const value = normalizeEvent({
            title: $('event-title').value,
            date: $('event-date').value,
            allDay: $('event-all-day').checked,
            start: $('event-start').value,
            end: $('event-end').value,
            color: document.querySelector('input[name="color"]:checked').value,
            notes: $('event-notes').value
        });
        setBusy(true);
        events = await callStorage('save', { ...value, ...(editingId ? { id: editingId } : {}) });
        setBusy(false);
        closeEditor();
        selectDate(value.date, true);
        notify(editingId ? 'Event updated' : 'Event saved');
    } catch (error) {
        setBusy(false);
        formError(error);
    }
}

async function deleteEvent() {
    if (busy || !editingId) return;
    try {
        setBusy(true);
        events = await callStorage('delete', editingId);
        setBusy(false);
        closeEditor();
        render();
        document.querySelector(`[data-date="${selected}"]`)?.focus();
        notify('Event deleted');
    } catch (error) {
        setBusy(false);
        formError(error);
    }
}

async function loadEvents() {
    $('retry-load').disabled = true;
    try {
        events = await callStorage('list');
        loaded = true;
        $('storage-status').textContent = 'Saved on this device';
        $('app-error').hidden = true;
    } catch (error) {
        loaded = false;
        $('storage-status').textContent = 'Events unavailable';
        $('app-error-text').textContent = error.message;
        $('app-error').hidden = false;
    } finally {
        $('retry-load').disabled = false;
        $('new-event').disabled = !loaded;
        $('add-to-day').disabled = !loaded;
        render();
    }
}

$('brand').addEventListener('click', event => { event.preventDefault(); goToday(); });
$('today').addEventListener('click', goToday);
$('previous-month').addEventListener('click', () => moveMonth(-1));
$('next-month').addEventListener('click', () => moveMonth(1));
$('month-picker').addEventListener('change', event => {
    if (isSupportedDate(`${event.target.value}-01`)) selectDate(`${event.target.value}-01`);
    else event.target.value = dateKey(visible).slice(0, 7);
});
$('search').addEventListener('input', renderSearch);
$('search').addEventListener('keydown', event => {
    if (event.key === 'Escape') { $('search').value = ''; renderSearch(); }
});
$('new-event').addEventListener('click', () => openEditor());
$('add-to-day').addEventListener('click', () => openEditor());
$('calendar-days').addEventListener('click', event => {
    const button = event.target.closest('[data-date]');
    if (!button || button.disabled) return;
    const key = button.dataset.date;
    const now = performance.now();
    const doubleClick = lastDayClick.key === key && now - lastDayClick.time < 450;
    lastDayClick = { key, time: now };
    selectDate(key, true);
    if (doubleClick) { lastDayClick.key = null; openEditor(); }
});
$('calendar-days').addEventListener('keydown', event => {
    if (!event.target.closest('[data-date]')) return;
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in offsets) {
        event.preventDefault();
        const date = parseDate(selected);
        date.setDate(date.getDate() + offsets[event.key]);
        selectDate(dateKey(date), true);
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
        event.preventDefault();
        selectDate(shiftMonth(selected, event.key === 'PageUp' ? -1 : 1), true);
    } else if (event.key === 'Enter') {
        event.preventDefault();
        openEditor();
    }
});
document.querySelector('.agenda-panel').addEventListener('click', event => {
    const card = event.target.closest('[data-event-id]');
    if (card) openEditor(card.dataset.eventId);
});
$('event-form').addEventListener('submit', saveEvent);
$('event-all-day').addEventListener('change', updateTimeFields);
for (const id of ['close-dialog', 'cancel-event']) $(id).addEventListener('click', closeEditor);
$('event-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('event-dialog').addEventListener('close', () => {
    if (dialogOpener?.isConnected) dialogOpener.focus();
    else document.querySelector(`[data-date="${selected}"]`)?.focus();
});
$('delete-event').addEventListener('click', () => { $('delete-confirmation').hidden = false; $('confirm-delete').focus(); });
$('cancel-delete').addEventListener('click', () => { $('delete-confirmation').hidden = true; $('delete-event').focus(); });
$('confirm-delete').addEventListener('click', deleteEvent);
$('retry-load').addEventListener('click', loadEvents);
window.addEventListener('calendar-restored', () => { loadEvents(); notify('Calendar restored from Drive'); });
document.addEventListener('keydown', event => {
    if ($('event-dialog').open || $('settings-dialog').open) return;
    const typing = event.target.matches('input, textarea, select') || event.target.isContentEditable;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault(); $('search').focus();
    } else if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'n') {
        event.preventDefault(); openEditor();
    } else if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 't') {
        event.preventDefault(); goToday();
    }
});

// Refresh the today marker if the app stays open past midnight or resumes from sleep.
function refreshToday() {
    const now = dateKey(new Date());
    if (now !== today) { today = now; render(); }
}
window.addEventListener('focus', refreshToday);
window.addEventListener('resize', () => {
    if (previewLimit() === currentPreviewLimit) return;
    const focusedDate = document.activeElement?.dataset.date;
    renderCalendar();
    if (focusedDate) document.querySelector(`[data-date="${focusedDate}"]`)?.focus();
});
setInterval(refreshToday, 60_000);
render();
loadEvents();
