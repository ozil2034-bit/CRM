import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Alert, Button, buttonClasses } from '@/design-system';
import { useT } from '@/hooks/useT';
import { cn } from '@/lib/utils/cn';
import {
  buildAgenda,
  buildMonthGrid,
  buildWeekGrid,
  eventsFromFittings,
  eventsFromReservations,
  monthOf,
  nextMonth,
  previousMonth,
  startOfMonth,
  type CalendarDay,
  type CalendarEvent,
  type CalendarEventKind,
} from '@/domain/calendar';
import { formatMuscatDate, toMuscatDate, toMuscatTime } from '@/domain/datetime';
import { observeReservations, type Reservation } from '@/services/reservations.service';
import { observeUpcomingFittings } from '@/services/fittings.service';

type View = 'month' | 'week' | 'agenda';

/**
 * The calendar.
 *
 * Month, week and day views over the same event list. All the arithmetic lives
 * in `@/domain/calendar` — this file places cells and handles clicks, so the
 * leap-year and week-start behaviour can be asserted without rendering
 * anything.
 *
 * Direction is inherited from the document, so the grid reverses wholesale in
 * Arabic: the logical properties (`ms-`, `text-start`) mean Saturday sits on
 * the correct edge in both languages without a second layout.
 */
export function CalendarPage() {
  const { t, language } = useT();
  const navigate = useNavigate();

  const [now] = useState(() => Date.now());
  const [view, setView] = useState<View>('month');
  const [month, setMonth] = useState(() => monthOf(Date.now()));
  const [anchor, setAnchor] = useState<number>(() => Date.now());
  const [selectedDay, setSelectedDay] = useState<string>(() => toMuscatDate(Date.now()));

  const [reservations, setReservations] = useState<Reservation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fittingEvents, setFittingEvents] = useState<CalendarEvent[]>([]);

  useEffect(() => {
    return observeReservations(
      (next) => {
        setReservations(next);
        setError(null);
      },
      (caught) => {
        setReservations([]);
        setError(caught.message);
      },
    );
  }, []);

  /*
   * Derived, not stored. The event list is a pure function of the reservations
   * and the display language, so keeping it in state would be a second copy
   * that can disagree with its source.
   */
  const events = useMemo(
    () =>
      reservations === null
        ? []
        : eventsFromReservations(
            reservations.map((reservation) => ({
              id: reservation.id,
              code: reservation.code,
              customerName:
                language === 'ar' && reservation.customerNameAr.length > 0
                  ? reservation.customerNameAr
                  : reservation.customerName,
              status: reservation.status,
              pickupAt: reservation.pickupAt,
              returnAt: reservation.returnAt,
              eventDate: reservation.eventDate,
              dressCode: '',
            })),
          ),
    [reservations, language],
  );

  useEffect(() => {
    return observeUpcomingFittings(
      (next) =>
        setFittingEvents(
          eventsFromFittings(
            next.map((fitting) => ({
              id: fitting.id,
              reservationId: fitting.reservationId,
              reservationCode: fitting.reservationCode,
              customerName: fitting.customerName,
              scheduledAt: fitting.scheduledAt,
              status: fitting.status,
            })),
          ),
        ),
      () => setFittingEvents([]),
    );
  }, []);

  const all = useMemo(() => [...events, ...fittingEvents], [events, fittingEvents]);

  const grid = useMemo(
    () => buildMonthGrid({ month, events: all, now }),
    [month, all, now],
  );

  const week = useMemo(
    () => buildWeekGrid({ anchor, events: all, now }),
    [anchor, all, now],
  );

  const agenda = useMemo(
    () => buildAgenda({ day: selectedDay, events: all }),
    [selectedDay, all],
  );

  const goToday = () => {
    setMonth(monthOf(now));
    setAnchor(now);
    setSelectedDay(toMuscatDate(now));
  };

  const step = (direction: -1 | 1) => {
    if (view === 'month') {
      setMonth(direction === 1 ? nextMonth(month) : previousMonth(month));
      return;
    }

    const days = view === 'week' ? 7 : 1;
    const shifted = (view === 'week' ? anchor : startOfDaySelected(selectedDay)) +
      direction * days * 24 * 60 * 60 * 1000;

    if (view === 'week') {
      setAnchor(shifted);
    } else {
      setSelectedDay(toMuscatDate(shifted));
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-5 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-caps">{t('nav.calendar')}</p>
          <h1 className="display mt-2 text-3xl text-ink-900">{headline(view, month, anchor, selectedDay, language)}</h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => step(-1)}>
            {t('calendar.previous')}
          </Button>
          <Button variant="secondary" size="sm" onClick={goToday}>
            {t('calendar.today')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => step(1)}>
            {t('calendar.next')}
          </Button>
        </div>
      </header>

      <div
        role="tablist"
        aria-label={t('calendar.title')}
        className="mt-6 flex gap-1 border-b border-ink-100 pb-3"
      >
        {(['month', 'week', 'agenda'] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={view === option}
            onClick={() => setView(option)}
            className={cn(
              'min-h-11 rounded-xs px-3 text-sm transition-colors',
              view === option ? 'text-ink-900' : 'text-ink-400 hover:text-ink-900',
            )}
          >
            {t(`calendar.${option}`)}
          </button>
        ))}
      </div>

      {error !== null && (
        <Alert tone="error" className="mt-6">
          {error}
        </Alert>
      )}

      {reservations === null && (
        <p className="mt-10 text-sm text-ink-400" role="status">
          {t('state.loading')}
        </p>
      )}

      {reservations !== null && view === 'month' && (
        <MonthGridView
          days={grid.days}
          month={month}
          onPick={(date) => {
            setSelectedDay(date);
            setView('agenda');
          }}
        />
      )}

      {reservations !== null && view === 'week' && (
        <WeekView
          days={week}
          onPick={(date) => {
            setSelectedDay(date);
            setView('agenda');
          }}
        />
      )}

      {reservations !== null && view === 'agenda' && (
        <AgendaView
          day={selectedDay}
          events={agenda}
          onOpen={(reservationId) => void navigate(`/reservations/${reservationId}`)}
        />
      )}
    </main>
  );
}

/* ------------------------------------------------------------------------ *
 * Month
 * ------------------------------------------------------------------------ */

/**
 * Weekday headings, starting Saturday.
 *
 * Rendered from a fixed instant known to be a Saturday, through the browser's
 * own locale machinery, so Arabic gets Arabic day names without a second table
 * to keep in step.
 */
function weekdayLabels(language: 'en' | 'ar'): string[] {
  // 2026-09-05 is a Saturday.
  const saturday = Date.UTC(2026, 8, 5);
  const formatter = new Intl.DateTimeFormat(language === 'ar' ? 'ar-OM' : 'en-GB', {
    weekday: 'short',
    timeZone: 'UTC',
  });

  return Array.from({ length: 7 }, (_unused, index) =>
    formatter.format(new Date(saturday + index * 24 * 60 * 60 * 1000)),
  );
}

function MonthGridView({
  days,
  month,
  onPick,
}: {
  days: readonly CalendarDay[];
  month: string;
  onPick: (date: string) => void;
}) {
  const { t, language } = useT();

  return (
    <div className="mt-6 overflow-x-auto">
      <div className="min-w-[42rem]">
        <div className="grid grid-cols-7 border-b border-ink-100 pb-2">
          {weekdayLabels(language).map((label) => (
            <div key={label} className="text-2xs tracking-wide text-ink-400 uppercase">
              {label}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {days.map((day) => (
            <button
              key={day.date}
              type="button"
              onClick={() => onPick(day.date)}
              aria-label={`${day.date}, ${String(day.events.length)}`}
              className={cn(
                'min-h-24 border-b border-e border-ink-100 p-1.5 text-start align-top transition-colors hover:bg-sand-50',
                day.inMonth ? 'bg-transparent' : 'bg-sand-50/40',
              )}
            >
              <span
                className={cn(
                  'numeric text-xs',
                  day.isToday && 'rounded-full bg-gold-500 px-1.5 py-0.5 text-white',
                  day.inMonth ? 'text-ink-700' : 'text-ink-300',
                )}
              >
                {day.date.slice(8)}
              </span>

              <ul className="mt-1 space-y-0.5">
                {day.events.slice(0, 3).map((event) => (
                  <li key={event.id} className="truncate text-2xs text-ink-600">
                    <EventDot kind={event.kind} /> {event.customerName}
                  </li>
                ))}
                {day.events.length > 3 && (
                  <li className="text-2xs text-ink-400">
                    +{day.events.length - 3} {t('calendar.moreEvents')}
                  </li>
                )}
              </ul>
            </button>
          ))}
        </div>
      </div>

      <Legend />
      <p className="sr-only">{month}</p>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Week and agenda
 * ------------------------------------------------------------------------ */

function WeekView({
  days,
  onPick,
}: {
  days: readonly CalendarDay[];
  onPick: (date: string) => void;
}) {
  const { t, language } = useT();

  return (
    <div className="mt-6">
      <ul className="divide-y divide-ink-100">
        {days.map((day) => (
          <li key={day.date}>
            <button
              type="button"
              onClick={() => onPick(day.date)}
              className="flex w-full min-h-16 flex-wrap items-start gap-x-4 gap-y-1 py-3 text-start hover:bg-sand-50"
            >
              <span
                className={cn(
                  'numeric w-32 shrink-0 text-sm',
                  day.isToday ? 'text-gold-700' : 'text-ink-600',
                )}
              >
                {formatMuscatDate(day.startsAt, language)}
              </span>

              {day.events.length === 0 ? (
                <span className="text-sm text-ink-300">{t('calendar.empty')}</span>
              ) : (
                <ul className="min-w-0 flex-1 space-y-1">
                  {day.events.map((event) => (
                    <li key={event.id} className="truncate text-sm text-ink-700">
                      <EventDot kind={event.kind} /> {t(`calendar.kind.${event.kind}`)} ·{' '}
                      {event.customerName}
                    </li>
                  ))}
                </ul>
              )}
            </button>
          </li>
        ))}
      </ul>

      <Legend />
    </div>
  );
}

function AgendaView({
  day,
  events,
  onOpen,
}: {
  day: string;
  events: readonly CalendarEvent[];
  onOpen: (reservationId: string) => void;
}) {
  const { t } = useT();

  return (
    <div className="mt-6">
      <h2 className="label-caps">{day}</h2>

      {events.length === 0 ? (
        <p className="mt-6 text-sm text-ink-500">{t('calendar.empty')}</p>
      ) : (
        <ul className="mt-4 divide-y divide-ink-100">
          {events.map((event) => (
            <li key={event.id}>
              <button
                type="button"
                onClick={() => onOpen(event.reservationId)}
                className="flex w-full min-h-14 flex-wrap items-center gap-x-4 gap-y-1 py-3 text-start hover:bg-sand-50"
              >
                <span className="numeric w-14 shrink-0 text-sm text-ink-600">
                  {event.kind === 'event' ? '—' : toMuscatTime(event.at)}
                </span>

                <span className="w-28 shrink-0 text-2xs text-ink-500">
                  <EventDot kind={event.kind} /> {t(`calendar.kind.${event.kind}`)}
                </span>

                <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                  {event.customerName}
                </span>

                <span className="code text-2xs text-ink-300">{event.reservationCode}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Legend />
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Shared bits
 * ------------------------------------------------------------------------ */

/**
 * A shape as well as a colour.
 *
 * Colour alone must never carry meaning, so each kind gets a distinct glyph and
 * the label beside it always names the kind in words.
 */
const GLYPH: Readonly<Record<CalendarEventKind, string>> = {
  pickup: '▲',
  return: '▼',
  fitting: '◆',
  event: '★',
};

const TONE: Readonly<Record<CalendarEventKind, string>> = {
  pickup: 'text-gold-700',
  return: 'text-ink-500',
  fitting: 'text-ink-400',
  event: 'text-gold-500',
};

function EventDot({ kind }: { kind: CalendarEventKind }) {
  return (
    <span aria-hidden="true" className={cn('text-2xs', TONE[kind])}>
      {GLYPH[kind]}
    </span>
  );
}

function Legend() {
  const { t } = useT();

  return (
    <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 border-t border-ink-100 pt-4">
      {(Object.keys(GLYPH) as CalendarEventKind[]).map((kind) => (
        <li key={kind} className="text-2xs text-ink-500">
          <EventDot kind={kind} /> {t(`calendar.kind.${kind}`)}
        </li>
      ))}
      <li className="ms-auto">
        <Link to="/reservations" className={buttonClasses('ghost', 'sm')}>
          {t('nav.reservations')}
        </Link>
      </li>
    </ul>
  );
}

function startOfDaySelected(day: string): number {
  return startOfMonth(day.slice(0, 7)) + (Number(day.slice(8)) - 1) * 24 * 60 * 60 * 1000;
}

function headline(
  view: View,
  month: string,
  anchor: number,
  day: string,
  language: 'en' | 'ar',
): string {
  if (view === 'agenda') return day;
  if (view === 'week') return formatMuscatDate(anchor, language);

  const formatter = new Intl.DateTimeFormat(language === 'ar' ? 'ar-OM' : 'en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return formatter.format(new Date(`${month}-01T00:00:00Z`));
}
