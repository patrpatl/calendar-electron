import test from 'node:test';
import assert from 'node:assert/strict';
import { dateKey, parseDate, monthDays, shiftMonth, normalizeEvent, sortEvents, searchEvents, isSupportedDate } from '../src/calendar.js';

const event = { title: 'Team lunch', date: '2026-10-30', allDay: false, start: '12:00', end: '13:00', color: 'teal', notes: 'Bring ideas' };

test('date parsing rejects overflow and keeps dates in local time', () => {
    assert.equal(dateKey(parseDate('2024-02-29')), '2024-02-29');
    assert.equal(parseDate('2026-10-30').getDate(), 30);
    for (const date of ['2025-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '10/30/2026']) assert.throws(() => parseDate(date));
    assert.equal(isSupportedDate('1899-12-31'), false);
    assert.equal(isSupportedDate('2101-01-01'), false);
});

test('month grid has six complete Sunday-first weeks and correct leap days', () => {
    const days = monthDays(2024, 1);
    assert.equal(days.length, 42);
    assert.equal(days[0].date.getDay(), 0);
    assert.equal(days.at(-1).date.getDay(), 6);
    assert.equal(new Set(days.map(day => day.key)).size, 42);
    assert.equal(days.filter(day => day.inMonth).length, 29);
    const december = monthDays(2026, 11);
    assert.ok(december.some(day => day.key.startsWith('2027-01')));
    const sunday = monthDays(2026, 1);
    assert.equal(sunday[0].key, '2026-02-01');
});

test('month navigation clamps short months and crosses years', () => {
    assert.equal(shiftMonth('2024-01-31', 1), '2024-02-29');
    assert.equal(shiftMonth('2025-03-31', -1), '2025-02-28');
    assert.equal(shiftMonth('2026-12-15', 1), '2027-01-15');
    assert.equal(shiftMonth('2026-01-15', -1), '2025-12-15');
});

test('event validation trims text, clears all-day times, and rejects invalid input', () => {
    assert.equal(normalizeEvent({ ...event, title: '  Lunch  ' }).title, 'Lunch');
    assert.equal(normalizeEvent({ ...event, allDay: true }).start, '');
    for (const patch of [
        { title: '   ' }, { title: 'a'.repeat(121) }, { date: '2026-02-30' }, { color: 'invalid' },
        { start: '' }, { start: '24:00' }, { end: '12:00' }, { end: '11:00' },
        { notes: 'a'.repeat(2001) }, { allDay: 'true' }
    ]) assert.throws(() => normalizeEvent({ ...event, ...patch }));
    assert.equal(normalizeEvent({ ...event, end: '' }).end, '');
});

test('agenda orders by date, all-day, then time; search includes notes', () => {
    const events = [
        { ...event, id: 'late', start: '15:00' },
        { ...event, id: 'early', start: '09:00' },
        { ...event, id: 'all-day', allDay: true, start: '' },
        { ...event, id: 'tomorrow', date: '2026-10-31' }
    ];
    assert.deepEqual(sortEvents(events).map(item => item.id), ['all-day', 'early', 'late', 'tomorrow']);
    assert.equal(searchEvents(events, ' IDEAS ').length, 4);
    assert.equal(searchEvents(events, 'lUnCh').length, 4);
    assert.equal(searchEvents(events, 'unmatched').length, 0);
    assert.equal(events[0].id, 'late');
});
