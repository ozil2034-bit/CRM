import { describe, expect, it } from 'vitest';

import { fromMuscatWallTime, startOfMuscatDay } from './datetime';
import {
  buildAgenda,
  buildMonthGrid,
  buildWeekGrid,
  CALENDAR_EVENT_KINDS,
  eventsFromFittings,
  eventsFromReservations,
  monthOf,
  monthQueryRange,
  nextMonth,
  previousMonth,
  startOfMonth,
  WEEK_STARTS_ON,
  type CalendarSource,
} from './calendar';

const at = (wall: string) => fromMuscatWallTime(wall);
const NOW = at('2026-09-12T10:00');

let sequence = 0;

function source(overrides: Partial<CalendarSource> = {}): CalendarSource {
  sequence += 1;
  return {
    id: `r-${sequence}`,
    code: `RSV-${String(sequence).padStart(4, '0')}`,
    customerName: 'Bride One',
    status: 'Reserved',
    pickupAt: at('2026-09-10T11:00'),
    returnAt: at('2026-09-12T18:00'),
    eventDate: '2026-09-11',
    dressCode: 'WD-0001',
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ *
 * Month arithmetic
 * ------------------------------------------------------------------------ */

describe('month arithmetic', () => {
  it('names the month an instant falls in, in Muscat', () => {
    expect(monthOf(at('2026-09-12T10:00'))).toBe('2026-09');
    // 23:00 Muscat on the 30th is 19:00 UTC — still September.
    expect(monthOf(at('2026-09-30T23:00'))).toBe('2026-09');
  });

  it('rolls the year over in December and January', () => {
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(previousMonth('2027-01')).toBe('2026-12');
  });

  it('pads single-digit months', () => {
    expect(nextMonth('2026-08')).toBe('2026-09');
    expect(previousMonth('2026-10')).toBe('2026-09');
  });

  it('starts a month at its first Muscat day', () => {
    expect(startOfMonth('2026-09')).toBe(startOfMuscatDay('2026-09-01'));
  });
});

/* ------------------------------------------------------------------------ *
 * The grid
 * ------------------------------------------------------------------------ */

describe('the month grid', () => {
  const grid = buildMonthGrid({ month: '2026-09', events: [], now: NOW });

  it('is always six whole weeks, so the calendar does not change height', () => {
    expect(grid.days).toHaveLength(42);
  });

  it('starts on a Saturday — the Omani week', () => {
    // Friday and Saturday are the weekend here; a Monday or Sunday start would
    // split it across two rows.
    expect(WEEK_STARTS_ON).toBe(6);

    const first = new Date(grid.days[0]!.startsAt + 4 * 60 * 60 * 1000).getUTCDay();
    expect(first).toBe(6);
  });

  it('marks which cells belong to the month', () => {
    const inMonth = grid.days.filter((day) => day.inMonth);

    expect(inMonth).toHaveLength(30);
    expect(inMonth[0]!.date).toBe('2026-09-01');
    expect(inMonth[29]!.date).toBe('2026-09-30');
  });

  it('pads with the neighbouring months rather than blank cells', () => {
    const lead = grid.days.filter((day) => !day.inMonth && day.date < '2026-09-01');
    const trail = grid.days.filter((day) => !day.inMonth && day.date > '2026-09-30');

    expect(lead.length + trail.length).toBe(12);
    expect(lead.every((day) => day.date.startsWith('2026-08'))).toBe(true);
  });

  it('marks today, and only today', () => {
    const todays = grid.days.filter((day) => day.isToday);

    expect(todays).toHaveLength(1);
    expect(todays[0]!.date).toBe('2026-09-12');
  });

  it('marks no cell as today when the month is not the current one', () => {
    const other = buildMonthGrid({ month: '2027-03', events: [], now: NOW });

    expect(other.days.filter((day) => day.isToday)).toHaveLength(0);
  });

  it('handles a leap February', () => {
    const leap = buildMonthGrid({ month: '2028-02', events: [], now: NOW });

    expect(leap.days.filter((day) => day.inMonth)).toHaveLength(29);
  });

  it('handles a non-leap February', () => {
    const plain = buildMonthGrid({ month: '2026-02', events: [], now: NOW });

    expect(plain.days.filter((day) => day.inMonth)).toHaveLength(28);
  });

  it('places events in the right cell', () => {
    const events = eventsFromReservations([source()]);
    const withEvents = buildMonthGrid({ month: '2026-09', events, now: NOW });

    const tenth = withEvents.days.find((day) => day.date === '2026-09-10');
    expect(tenth?.events.map((event) => event.kind)).toEqual(['pickup']);
  });

  it('orders several events in a cell by time', () => {
    const events = eventsFromReservations([
      source({ pickupAt: at('2026-09-10T16:00') }),
      source({ pickupAt: at('2026-09-10T09:00') }),
    ]);

    const withEvents = buildMonthGrid({ month: '2026-09', events, now: NOW });
    const tenth = withEvents.days.find((day) => day.date === '2026-09-10');

    const pickups = tenth!.events.filter((event) => event.kind === 'pickup');
    expect(pickups[0]!.at).toBeLessThan(pickups[1]!.at);
  });
});

describe('the week grid', () => {
  it('is seven days beginning on Saturday', () => {
    const week = buildWeekGrid({ anchor: at('2026-09-12T10:00'), events: [], now: NOW });

    expect(week).toHaveLength(7);
    expect(new Date(week[0]!.startsAt + 4 * 60 * 60 * 1000).getUTCDay()).toBe(6);
  });

  it('contains the day it was anchored on', () => {
    const week = buildWeekGrid({ anchor: at('2026-09-12T10:00'), events: [], now: NOW });

    expect(week.map((day) => day.date)).toContain('2026-09-12');
  });

  it('does not change when anchored anywhere in the same week', () => {
    const monday = buildWeekGrid({ anchor: at('2026-09-14T10:00'), events: [], now: NOW });
    const wednesday = buildWeekGrid({ anchor: at('2026-09-16T10:00'), events: [], now: NOW });

    expect(monday.map((day) => day.date)).toEqual(wednesday.map((day) => day.date));
  });
});

describe('the agenda', () => {
  it('lists one day in time order', () => {
    const events = eventsFromReservations([
      source({ pickupAt: at('2026-09-10T16:00'), returnAt: at('2026-09-10T09:00') }),
    ]);

    const agenda = buildAgenda({ day: '2026-09-10', events });

    expect(agenda).toHaveLength(2);
    expect(agenda[0]!.at).toBeLessThan(agenda[1]!.at);
  });

  it('is empty for a day with nothing on it', () => {
    expect(buildAgenda({ day: '2026-09-25', events: [] })).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------------ */

describe('turning reservations into events', () => {
  it('produces a pickup, a return and an event date', () => {
    const events = eventsFromReservations([source()]);

    expect(events.map((event) => event.kind).sort()).toEqual(['event', 'pickup', 'return']);
  });

  it('omits the event marker when no event date was recorded', () => {
    const events = eventsFromReservations([source({ eventDate: '' })]);

    expect(events.map((event) => event.kind).sort()).toEqual(['pickup', 'return']);
  });

  it('OMITS a cancelled booking entirely', () => {
    // Nobody is coming, and leaving it on the calendar would have staff
    // preparing for a customer who will not arrive.
    expect(eventsFromReservations([source({ status: 'Cancelled' })])).toEqual([]);
    expect(eventsFromReservations([source({ status: 'No-Show' })])).toEqual([]);
  });

  it('keeps a booking that is merely finished, so history stays visible', () => {
    expect(eventsFromReservations([source({ status: 'Closed' })])).not.toEqual([]);
  });

  it('carries what a cell needs to render without another read', () => {
    // Against the fixture actually built: the code counter is shared across this
    // file, so hard-coding one would break the moment a test is added above.
    const reservation = source();
    const events = eventsFromReservations([reservation]);

    expect(events[0]).toMatchObject({
      reservationId: reservation.id,
      reservationCode: reservation.code,
      customerName: 'Bride One',
      dressCode: 'WD-0001',
    });
  });

  it('places each event on its own Muscat day', () => {
    const events = eventsFromReservations([
      source({ pickupAt: at('2026-09-10T23:30'), returnAt: at('2026-09-13T00:30') }),
    ]);

    const pickup = events.find((event) => event.kind === 'pickup');
    const returned = events.find((event) => event.kind === 'return');

    expect(pickup?.day).toBe('2026-09-10');
    expect(returned?.day).toBe('2026-09-13');
  });
});

describe('turning fittings into events', () => {
  const fitting = {
    id: 'f-1',
    reservationId: 'r-1',
    reservationCode: 'RSV-0001',
    customerName: 'Bride One',
    scheduledAt: at('2026-09-11T15:00'),
    status: 'Scheduled',
  };

  it('produces a fitting event on the right day', () => {
    const events = eventsFromFittings([fitting]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'fitting', day: '2026-09-11' });
  });

  it('omits a cancelled fitting', () => {
    expect(eventsFromFittings([{ ...fitting, status: 'Cancelled' }])).toEqual([]);
  });
});

describe('accessibility of event kinds', () => {
  it('defines a distinct kind per event type, so colour is never the only cue', () => {
    expect([...CALENDAR_EVENT_KINDS]).toEqual(['pickup', 'return', 'fitting', 'event']);
  });
});

/* ------------------------------------------------------------------------ *
 * Query scoping (§44)
 * ------------------------------------------------------------------------ */

describe('the query window a month needs', () => {
  it('covers the whole padded grid, not just the calendar month', () => {
    // A query scoped to September alone would leave the leading and trailing
    // cells empty.
    const range = monthQueryRange('2026-09');
    const grid = buildMonthGrid({ month: '2026-09', events: [], now: NOW });

    expect(range.from).toBe(grid.days[0]!.startsAt);
    expect(range.to).toBeGreaterThan(grid.days[41]!.startsAt);
  });

  it('is bounded — never an unscoped read of the whole collection', () => {
    const range = monthQueryRange('2026-09');
    const days = (range.to - range.from) / (24 * 60 * 60 * 1000);

    expect(days).toBe(42);
  });
});
