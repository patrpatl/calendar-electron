import { normalizeEvent } from '../src/calendar.js';

export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

export function validateEvents(events) {
    if (!Array.isArray(events)) throw new Error('The backup does not contain a valid calendar.');
    const ids = new Set();
    return events.map(event => {
        if (!event || typeof event.id !== 'string' || !event.id || event.id.length > 128 || ids.has(event.id)) {
            throw new Error('The backup contains invalid or duplicate event IDs.');
        }
        ids.add(event.id);
        return { id: event.id, ...normalizeEvent(event) };
    });
}

export function createBackup(events, now = new Date()) {
    const backup = { app: 'calendar-electron', version: 1, createdAt: now.toISOString(), events: validateEvents(events) };
    if (Buffer.byteLength(JSON.stringify(backup)) > MAX_BACKUP_BYTES) throw new Error('This calendar exceeds the 5 MB Drive backup limit.');
    return backup;
}

export function parseBackup(value) {
    if (!value || value.app !== 'calendar-electron' || value.version !== 1 || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
        throw new Error('This Drive file is not a supported Calendar backup. Your local events have not changed.');
    }
    return { app: value.app, version: 1, createdAt: value.createdAt, events: validateEvents(value.events) };
}
