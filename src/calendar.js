export const COLORS = ['teal', 'blue', 'violet', 'amber', 'rose'];
export const MIN_YEAR = 1900;
export const MAX_YEAR = 2100;

// Use local calendar dates, never UTC conversion (which can shift a day).
export function dateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function parseDate(key) {
    if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('Choose a valid date.');
    const [year, month, day] = key.split('-').map(Number);
    const date = new Date(year, month - 1, day, 12);
    if (dateKey(date) !== key) throw new Error('Choose a valid date.');
    return date;
}

export function monthDays(year, month) {
    const first = new Date(year, month, 1, 12);
    const start = new Date(year, month, 1 - first.getDay(), 12);
    return Array.from({ length: 42 }, (_, index) => {
        const date = new Date(start);
        date.setDate(start.getDate() + index);
        return { key: dateKey(date), day: date.getDate(), inMonth: date.getMonth() === month, date };
    });
}

export function shiftMonth(key, offset) {
    const date = parseDate(key);
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + offset);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0, 12).getDate();
    date.setDate(Math.min(day, lastDay));
    return dateKey(date);
}

export function isSupportedDate(key) {
    try {
        const year = parseDate(key).getFullYear();
        return year >= MIN_YEAR && year <= MAX_YEAR;
    } catch {
        return false;
    }
}

export function normalizeEvent(value) {
    if (!value || typeof value !== 'object') throw new Error('Invalid event.');
    if (typeof value.title !== 'string' || !value.title.trim() || value.title.trim().length > 120) throw new Error('Enter an event name of 1–120 characters.');
    if (!isSupportedDate(value.date)) throw new Error('Choose a date between 1900 and 2100.');
    if (typeof value.allDay !== 'boolean') throw new Error('Choose whether this is an all-day event.');
    if (!COLORS.includes(value.color)) throw new Error('Choose a valid event color.');
    if (typeof value.notes !== 'string' || value.notes.length > 2000) throw new Error('Notes can contain up to 2,000 characters.');
    const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
    const start = value.allDay ? '' : value.start;
    const end = value.allDay ? '' : value.end;
    if (!value.allDay && (!timePattern.test(start) || typeof start !== 'string')) throw new Error('Choose a start time.');
    if (!value.allDay && (typeof end !== 'string' || (end !== '' && !timePattern.test(end)))) throw new Error('Choose a valid end time.');
    if (end && end <= start) throw new Error('The end time must be after the start time on the same day.');
    return { title: value.title.trim(), date: value.date, allDay: value.allDay, start, end, color: value.color, notes: value.notes.trim() };
}

export function sortEvents(events) {
    return [...events].sort((a, b) => a.date.localeCompare(b.date) || Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

export function searchEvents(events, query) {
    const needle = query.trim().toLocaleLowerCase();
    return sortEvents(events.filter(event => `${event.title}\n${event.notes}`.toLocaleLowerCase().includes(needle)));
}
