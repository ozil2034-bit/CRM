/**
 * Utilization.
 *
 * How hard a dress is working. The single most misleadable number in the whole
 * platform, so the definition is written down here and nowhere else.
 *
 * ## The formula
 *
 * ```
 * utilization = blocked days in the period / operating days in the period
 * ```
 *
 * **Blocked days** are the days a gown could not be rented to anyone else:
 * the booked interval *plus its cleaning buffer*, which is exactly the interval
 * the availability engine already computes. Counting only the rental days would
 * flatter the figure — the buffer is time the gown genuinely cannot earn.
 *
 * **Operating days** are the days the dress was actually available to the
 * boutique in the period: the period's length, less any stretch before it was
 * added to the inventory or after it was retired. Measuring a gown bought in
 * November against a full year would make every new dress look idle.
 *
 * ## When there is no answer
 *
 * A dress with **zero operating days** in a period has no utilization. Not 0% —
 * zero percent means "available and never booked", which is a judgement about
 * the gown. `null` means "the question does not apply", and the interface shows
 * N/A. Reporting a fabricated 0% against a dress that did not exist yet would
 * misinform the owner about her own stock.
 *
 * Pure: the period is a parameter.
 */

import { MS_PER_DAY, startOfMuscatDay, toMuscatDate, type EpochMs } from './datetime';

export interface UtilizationPeriod {
  /** Inclusive. */
  readonly from: EpochMs;
  /** Exclusive, so consecutive periods neither overlap nor double-count. */
  readonly to: EpochMs;
}

/** A blocked interval, as `reservationItems` already stores it. */
export interface BlockedSpan {
  readonly blockStartAt: EpochMs;
  readonly blockEndAt: EpochMs;
  readonly blocking: boolean;
}

export interface UtilizationInput {
  readonly period: UtilizationPeriod;
  readonly spans: readonly BlockedSpan[];
  /** When the dress entered the inventory. */
  readonly availableFrom: EpochMs;
  /** When it was retired, or null if it is still in service. */
  readonly retiredAt: EpochMs | null;
}

export interface UtilizationResult {
  /** `null` when the dress had no operating days — shown as N/A, never 0%. */
  readonly percent: number | null;
  readonly blockedDays: number;
  readonly operatingDays: number;
}

/**
 * Whole days between two instants, on Muscat calendar days, **half-open**.
 *
 * Measured between day boundaries rather than in elapsed milliseconds, so a
 * block from 23:00 to 01:00 the next morning is the day it consumed rather than
 * the two hours the clock reports.
 *
 * Half-open matches the blocked intervals themselves: `[start, end)` means
 * another booking may begin exactly at `end`, so the closing day belongs to
 * whichever booking starts on it. Counting it for both would let a fully-booked
 * gown exceed its own period — a rounding artefact reading "104% utilised"
 * would rightly destroy confidence in the whole report.
 *
 * Floored at one day when any time at all was consumed: a gown out for three
 * hours on a Saturday could not be rented that Saturday.
 */
function calendarDaySpan(from: EpochMs, to: EpochMs): number {
  if (to <= from) return 0;

  const start = startOfMuscatDay(toMuscatDate(from));
  const end = startOfMuscatDay(toMuscatDate(to));

  const days = Math.round((end - start) / MS_PER_DAY);
  return days > 0 ? days : 1;
}

/** The part of a span that falls inside the period. */
function clampToPeriod(
  span: { start: EpochMs; end: EpochMs },
  period: UtilizationPeriod,
): { start: EpochMs; end: EpochMs } | null {
  const start = Math.max(span.start, period.from);
  const end = Math.min(span.end, period.to);

  return end > start ? { start, end } : null;
}

/**
 * Merge overlapping spans before counting.
 *
 * Two bookings of the same gown cannot overlap, but a booking and its cleaning
 * buffer can abut, and clamping to a period can produce touching ranges.
 * Counting them separately would let a dress exceed 100%, which would be
 * visibly wrong on a report and quietly wrong in an average.
 */
function mergeSpans(
  spans: readonly { start: EpochMs; end: EpochMs }[],
): { start: EpochMs; end: EpochMs }[] {
  if (spans.length === 0) return [];

  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: { start: EpochMs; end: EpochMs }[] = [{ ...(sorted[0] as { start: EpochMs; end: EpochMs }) }];

  for (const span of sorted.slice(1)) {
    const last = merged[merged.length - 1] as { start: EpochMs; end: EpochMs };

    if (span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  return merged;
}

/**
 * Compute utilization for one dress over one period.
 *
 * @throws never — an impossible period returns `percent: null` rather than
 *         throwing, because a report must render even when its inputs are odd.
 */
export function computeUtilization(input: UtilizationInput): UtilizationResult {
  const { period } = input;

  /* --- Operating days: the period, less time the dress did not exist --- */

  const serviceStart = Math.max(period.from, input.availableFrom);
  const serviceEnd = Math.min(period.to, input.retiredAt ?? period.to);

  const operatingDays = calendarDaySpan(serviceStart, serviceEnd);

  if (operatingDays <= 0) {
    return { percent: null, blockedDays: 0, operatingDays: 0 };
  }

  /* --- Blocked days: merged, clamped to the period and to service --- */

  const clamped = input.spans
    .filter((span) => span.blocking)
    .map((span) => ({ start: span.blockStartAt, end: span.blockEndAt }))
    .map((span) =>
      clampToPeriod(span, { from: serviceStart, to: serviceEnd }),
    )
    .filter((span): span is { start: EpochMs; end: EpochMs } => span !== null);

  const blockedDays = mergeSpans(clamped).reduce(
    (total, span) => total + calendarDaySpan(span.start, span.end),
    0,
  );

  /*
   * Capped at 100%. A gown cannot be more than fully occupied, and a rounding
   * artefact reading "104% utilised" would rightly destroy confidence in the
   * whole report.
   */
  const percent = Math.min(100, Math.round((blockedDays / operatingDays) * 100));

  return { percent, blockedDays, operatingDays };
}

export interface DressUtilization {
  readonly dressId: string;
  readonly dressCode: string;
  readonly dressName: string;
  readonly result: UtilizationResult;
}

/**
 * Average utilization across the inventory.
 *
 * Dresses with no operating days are **excluded** rather than counted as zero.
 * Including them would drag the boutique's average down every time it bought a
 * gown, which is precisely backwards.
 *
 * Returns `null` when nothing had operating days.
 */
export function averageUtilization(rows: readonly DressUtilization[]): number | null {
  const measurable = rows.filter((row) => row.result.percent !== null);

  if (measurable.length === 0) return null;

  const total = measurable.reduce((sum, row) => sum + (row.result.percent ?? 0), 0);
  return Math.round(total / measurable.length);
}
