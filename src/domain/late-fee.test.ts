import { describe, expect, it } from 'vitest';

import { fromMuscatWallTime } from './datetime';
import { baisa } from './money';
import { computeLateFee, isChargeable, parseLateFeeSnapshot, LateFeeError } from './late-fee';

const DUE = fromMuscatWallTime('2026-09-12T11:00');
const RATE = baisa(10_000); // OMR 10.000 per day
const NOW = fromMuscatWallTime('2026-09-20T09:00');

const at = (wall: string) => fromMuscatWallTime(wall);

describe('a return that is not late', () => {
  it('charges nothing when returned exactly on time', () => {
    const fee = computeLateFee({
      scheduledReturnAt: DUE,
      actualReturnAt: DUE,
      dailyRate: RATE,
      calculatedAt: NOW,
    });

    expect(fee.lateDays).toBe(0);
    expect(fee.amount).toBe(0);
    expect(isChargeable(fee)).toBe(false);
  });

  it('charges nothing when returned early', () => {
    const fee = computeLateFee({
      scheduledReturnAt: DUE,
      actualReturnAt: at('2026-09-10T11:00'),
      dailyRate: RATE,
      calculatedAt: NOW,
    });

    expect(fee.lateDays).toBe(0);
    expect(fee.amount).toBe(0);
  });

  it('never produces a negative fee for an early return', () => {
    const fee = computeLateFee({
      scheduledReturnAt: DUE,
      actualReturnAt: at('2026-01-01T11:00'),
      dailyRate: RATE,
      calculatedAt: NOW,
    });

    expect(fee.amount).toBeGreaterThanOrEqual(0);
  });
});

describe('a late return', () => {
  it('charges one day when one day late', () => {
    const fee = computeLateFee({
      scheduledReturnAt: DUE,
      actualReturnAt: at('2026-09-13T11:00'),
      dailyRate: RATE,
      calculatedAt: NOW,
    });

    expect(fee.lateDays).toBe(1);
    expect(fee.amount).toBe(10_000);
    expect(isChargeable(fee)).toBe(true);
  });

  it('charges several days when several days late', () => {
    const fee = computeLateFee({
      scheduledReturnAt: DUE,
      actualReturnAt: at('2026-09-17T11:00'),
      dailyRate: RATE,
      calculatedAt: NOW,
    });

    expect(fee.lateDays).toBe(5);
    expect(fee.amount).toBe(50_000);
  });

  it('rounds a part day UP — the boutique has lost the day either way', () => {
    const fee = computeLateFee({
      scheduledReturnAt: DUE,
      actualReturnAt: at('2026-09-12T23:00'),
      dailyRate: RATE,
      calculatedAt: NOW,
    });

    expect(fee.lateDays).toBe(1);
    expect(fee.amount).toBe(10_000);
  });

  it('treats one minute late as a full day', () => {
    const fee = computeLateFee({
      scheduledReturnAt: DUE,
      actualReturnAt: DUE + 60_000,
      dailyRate: RATE,
      calculatedAt: NOW,
    });

    expect(fee.lateDays).toBe(1);
  });
});

describe('the rate', () => {
  it('charges nothing when the boutique has configured no late fee', () => {
    const fee = computeLateFee({
      scheduledReturnAt: DUE,
      actualReturnAt: at('2026-09-20T11:00'),
      dailyRate: baisa(0),
      calculatedAt: NOW,
    });

    expect(fee.lateDays).toBe(8);
    expect(fee.amount).toBe(0);
    expect(isChargeable(fee)).toBe(false);
  });

  it('refuses a negative rate rather than paying the customer to be late', () => {
    expect(() =>
      computeLateFee({
        scheduledReturnAt: DUE,
        actualReturnAt: at('2026-09-14T11:00'),
        dailyRate: baisa(-1_000),
        calculatedAt: NOW,
      }),
    ).toThrow(LateFeeError);
  });

  it('refuses a fractional rate', () => {
    expect(() =>
      computeLateFee({
        scheduledReturnAt: DUE,
        actualReturnAt: at('2026-09-14T11:00'),
        dailyRate: 10.5 as never,
        calculatedAt: NOW,
      }),
    ).toThrow(LateFeeError);
  });

  it('multiplies exactly at three decimals', () => {
    const fee = computeLateFee({
      scheduledReturnAt: DUE,
      actualReturnAt: at('2026-09-15T11:00'),
      dailyRate: baisa(1),
      calculatedAt: NOW,
    });

    expect(fee.amount).toBe(3);
    expect(Number.isInteger(fee.amount)).toBe(true);
  });
});

describe('the snapshot', () => {
  it('records the rate and the days alongside the amount', () => {
    // So the charge is still explainable after the boutique raises its rate.
    const fee = computeLateFee({
      scheduledReturnAt: DUE,
      actualReturnAt: at('2026-09-15T11:00'),
      dailyRate: RATE,
      calculatedAt: NOW,
    });

    expect(fee).toMatchObject({
      lateDays: 3,
      dailyRate: 10_000,
      amount: 30_000,
      scheduledReturnAt: DUE,
      calculatedAt: NOW,
    });
  });

  it('round-trips through storage', () => {
    const fee = computeLateFee({
      scheduledReturnAt: DUE,
      actualReturnAt: at('2026-09-15T11:00'),
      dailyRate: RATE,
      calculatedAt: NOW,
    });

    expect(parseLateFeeSnapshot({ ...fee })).toEqual(fee);
  });

  it('refuses to restore a malformed snapshot rather than guessing', () => {
    expect(parseLateFeeSnapshot(null)).toBeNull();
    expect(parseLateFeeSnapshot({})).toBeNull();
    expect(parseLateFeeSnapshot({ lateDays: 'three' })).toBeNull();
    expect(parseLateFeeSnapshot({ ...{ lateDays: 1, dailyRate: 1, amount: 1 } })).toBeNull();
  });
});
