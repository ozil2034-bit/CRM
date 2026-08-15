import { describe, expect, it } from 'vitest';

import {
  planImport,
  totalRecordsIn,
  validateBackup,
  BACKUP_COLLECTIONS,
  CURRENT_SCHEMA_VERSION,
  FORBIDDEN_FIELDS,
  type BackupCollection,
  type BackupFile,
  type BackupProblemKind,
} from './backup';

function file(overrides: Partial<BackupFile> = {}): BackupFile {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: '2026-09-12T06:00:00.000Z',
    applicationVersion: '0.1.0',
    projectId: 'demo-azhary',
    environment: 'development',
    collections: {},
    ...overrides,
  };
}

const kinds = (input: unknown): BackupProblemKind[] =>
  validateBackup(input).problems.map((problem) => problem.kind);

/* ------------------------------------------------------------------------ *
 * The envelope
 * ------------------------------------------------------------------------ */

describe('the envelope', () => {
  it('accepts a well-formed empty backup', () => {
    expect(validateBackup(file()).ok).toBe(true);
  });

  it('refuses anything that is not an object', () => {
    for (const input of ['a string', 42, null, [], true]) {
      expect(validateBackup(input).ok).toBe(false);
    }
    expect(kinds('a string')).toContain('NOT_AN_OBJECT');
  });

  it('REFUSES a file with no schemaVersion', () => {
    const { schemaVersion: _unused, ...rest } = file();

    expect(kinds(rest)).toContain('MISSING_SCHEMA_VERSION');
  });

  it('refuses a schema version this application cannot read', () => {
    expect(kinds(file({ schemaVersion: 99 }))).toContain('UNSUPPORTED_SCHEMA_VERSION');
    expect(kinds(file({ schemaVersion: 0 }))).toContain('UNSUPPORTED_SCHEMA_VERSION');
  });

  it('refuses a missing or unparseable export date', () => {
    const { exportedAt: _unused, ...rest } = file();

    expect(kinds(rest)).toContain('MISSING_EXPORTED_AT');
    expect(kinds(file({ exportedAt: 'last Tuesday' }))).toContain('INVALID_EXPORTED_AT');
  });

  it('refuses a file with no collections object at all', () => {
    const { collections: _unused, ...rest } = file();

    expect(kinds(rest)).toContain('MISSING_COLLECTIONS');
  });

  it('refuses a collection it does not recognise', () => {
    const problems = kinds({
      ...file(),
      collections: { somethingElse: [] },
    });

    expect(problems).toContain('UNKNOWN_COLLECTION');
  });
});

/* ------------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------------ */

describe('records', () => {
  const withCustomers = (records: unknown[]) =>
    validateBackup({ ...file(), collections: { customers: records } });

  it('accepts a well-formed record', () => {
    expect(withCustomers([{ id: 'c-1', data: { nameEn: 'Fatima' } }]).ok).toBe(true);
  });

  it('refuses a record with no id — a restore could not place it', () => {
    expect(withCustomers([{ data: {} }]).problems.map((p) => p.kind)).toContain('MISSING_ID');
  });

  it('REFUSES two records sharing an id', () => {
    /*
     * A restore could not say which is correct, and picking either silently
     * discards real data.
     */
    const result = withCustomers([
      { id: 'c-1', data: { nameEn: 'Fatima' } },
      { id: 'c-1', data: { nameEn: 'Sara' } },
    ]);

    expect(result.problems.map((p) => p.kind)).toContain('DUPLICATE_ID');
  });

  it('refuses a record that is not an object', () => {
    expect(withCustomers(['nope']).problems.map((p) => p.kind)).toContain('RECORD_NOT_AN_OBJECT');
  });

  it('refuses a record with no data object', () => {
    expect(withCustomers([{ id: 'c-1' }]).problems.map((p) => p.kind)).toContain(
      'RECORD_NOT_AN_OBJECT',
    );
  });

  it('refuses a collection whose value is not a list', () => {
    const result = validateBackup({ ...file(), collections: { customers: { id: 'c-1' } } });

    expect(result.problems.map((p) => p.kind)).toContain('RECORD_NOT_AN_OBJECT');
  });

  it('counts records per collection for the summary', () => {
    const result = withCustomers([
      { id: 'c-1', data: {} },
      { id: 'c-2', data: {} },
    ]);

    expect(result.counts.customers).toBe(2);
    expect(result.totalRecords).toBe(2);
  });
});

/* ------------------------------------------------------------------------ *
 * Secrets
 * ------------------------------------------------------------------------ */

describe('credentials', () => {
  it('REFUSES a backup containing a bootstrap token', () => {
    /*
     * An export is a file an owner emails to themselves. A bootstrap token in
     * it is a permanent grant of ownership to anybody who reads that mailbox.
     */
    const result = validateBackup({
      ...file(),
      collections: { settings: [{ id: 'app', data: { bootstrapToken: 'secret' } }] },
    });

    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.kind)).toContain('FORBIDDEN_FIELD');
  });

  it('refuses every field on the forbidden list', () => {
    for (const field of FORBIDDEN_FIELDS) {
      const result = validateBackup({
        ...file(),
        collections: { settings: [{ id: 'app', data: { [field]: 'x' } }] },
      });

      expect(result.problems.map((p) => p.kind)).toContain('FORBIDDEN_FIELD');
    }
  });

  it('finds a credential NESTED inside a record', () => {
    const result = validateBackup({
      ...file(),
      collections: { settings: [{ id: 'app', data: { nested: { deep: { apiKey: 'x' } } } }] },
    });

    expect(result.problems.map((p) => p.kind)).toContain('FORBIDDEN_FIELD');
  });
});

/* ------------------------------------------------------------------------ *
 * Money and time
 * ------------------------------------------------------------------------ */

describe('money', () => {
  const withEvent = (data: Record<string, unknown>) =>
    validateBackup({ ...file(), collections: { financialEvents: [{ id: 'e-1', data }] } });

  it('accepts whole baisa', () => {
    expect(withEvent({ amount: 120_000 }).ok).toBe(true);
  });

  it('accepts zero', () => {
    expect(withEvent({ amount: 0 }).ok).toBe(true);
  });

  it('REFUSES a fractional amount', () => {
    // A float in the ledger is the failure the whole money model exists to stop.
    expect(withEvent({ amount: 120_000.5 }).problems.map((p) => p.kind)).toContain(
      'INVALID_MONEY',
    );
  });

  it('refuses money that is a string', () => {
    expect(withEvent({ amount: '120000' }).problems.map((p) => p.kind)).toContain('INVALID_MONEY');
  });

  it('accepts a null optional amount', () => {
    expect(withEvent({ salePrice: null }).ok).toBe(true);
  });

  it('finds fractional money nested inside a pricing snapshot', () => {
    const result = validateBackup({
      ...file(),
      collections: {
        reservations: [{ id: 'r-1', data: { pricing: { grandTotal: 1.5 } } }],
      },
    });

    expect(result.problems.map((p) => p.kind)).toContain('INVALID_MONEY');
  });

  it('finds fractional money inside an array of line items', () => {
    const result = validateBackup({
      ...file(),
      collections: {
        reservations: [{ id: 'r-1', data: { pricing: { items: [{ rentalPrice: 0.5 }] } } }],
      },
    });

    expect(result.problems.map((p) => p.kind)).toContain('INVALID_MONEY');
  });

  it('does NOT treat an ordinary count as money', () => {
    // `quantity: 3` is a count, not baisa; checking every number would be wrong.
    const result = validateBackup({
      ...file(),
      collections: { reservations: [{ id: 'r-1', data: { quantity: 3 } }] },
    });

    expect(result.ok).toBe(true);
  });
});

describe('timestamps', () => {
  const withReservation = (data: Record<string, unknown>) =>
    validateBackup({ ...file(), collections: { reservations: [{ id: 'r-1', data }] } });

  it('accepts epoch milliseconds', () => {
    expect(withReservation({ pickupAt: 1_789_000_000_000 }).ok).toBe(true);
  });

  it('accepts null — a gown that has not come back has no actual return', () => {
    expect(withReservation({ actualReturnAt: null }).ok).toBe(true);
  });

  it('refuses a timestamp that is a string', () => {
    expect(withReservation({ pickupAt: '2026-09-10' }).problems.map((p) => p.kind)).toContain(
      'INVALID_TIMESTAMP',
    );
  });

  it('refuses a negative instant', () => {
    expect(withReservation({ pickupAt: -1 }).problems.map((p) => p.kind)).toContain(
      'INVALID_TIMESTAMP',
    );
  });

  it('REFUSES a seconds/milliseconds mix-up', () => {
    // 1e15 is the year 33658 — a unit error, not an unusual booking.
    expect(withReservation({ pickupAt: 1e15 }).problems.map((p) => p.kind)).toContain(
      'INVALID_TIMESTAMP',
    );
  });

  it('refuses NaN', () => {
    expect(withReservation({ pickupAt: Number.NaN }).problems.map((p) => p.kind)).toContain(
      'INVALID_TIMESTAMP',
    );
  });
});

/* ------------------------------------------------------------------------ *
 * References
 * ------------------------------------------------------------------------ */

describe('references', () => {
  it('accepts a reservation pointing at a customer in the same file', () => {
    const result = validateBackup({
      ...file(),
      collections: {
        customers: [{ id: 'c-1', data: {} }],
        reservations: [{ id: 'r-1', data: { customerId: 'c-1' } }],
      },
    });

    expect(result.ok).toBe(true);
  });

  it('REFUSES a reservation pointing at a customer that is not there', () => {
    const result = validateBackup({
      ...file(),
      collections: {
        customers: [{ id: 'c-1', data: {} }],
        reservations: [{ id: 'r-1', data: { customerId: 'c-9' } }],
      },
    });

    expect(result.problems.map((p) => p.kind)).toContain('BROKEN_REFERENCE');
  });

  it('refuses an orphaned reservation item, payment and invoice', () => {
    for (const [collection, field] of [
      ['reservationItems', 'reservationId'],
      ['financialEvents', 'reservationId'],
      ['invoices', 'reservationId'],
    ] as const) {
      const result = validateBackup({
        ...file(),
        collections: {
          reservations: [{ id: 'r-1', data: {} }],
          [collection]: [{ id: 'x-1', data: { [field]: 'r-9' } }],
        },
      });

      expect(result.problems.map((p) => p.kind)).toContain('BROKEN_REFERENCE');
    }
  });

  it('does NOT complain when the target collection is absent entirely', () => {
    /*
     * A partial export — one collection only — is a legitimate thing to hold.
     * Absent is not broken; only present-and-missing is.
     */
    const result = validateBackup({
      ...file(),
      collections: { reservations: [{ id: 'r-1', data: { customerId: 'c-1' } }] },
    });

    expect(result.ok).toBe(true);
  });

  it('ignores an empty reference rather than calling it broken', () => {
    const result = validateBackup({
      ...file(),
      collections: {
        customers: [],
        reservations: [{ id: 'r-1', data: { customerId: '' } }],
      },
    });

    expect(result.problems.map((p) => p.kind)).not.toContain('BROKEN_REFERENCE');
  });
});

/* ------------------------------------------------------------------------ *
 * Reporting everything at once
 * ------------------------------------------------------------------------ */

describe('the problem report', () => {
  it('reports EVERY problem, not just the first', () => {
    // An owner fixing a corrupted export needs the list, not one error at a time.
    const result = validateBackup({
      schemaVersion: 99,
      exportedAt: 'nonsense',
      collections: {
        customers: [
          { id: 'c-1', data: { apiKey: 'x' } },
          { id: 'c-1', data: {} },
        ],
      },
    });

    const found = new Set(result.problems.map((problem) => problem.kind));

    expect(found.has('UNSUPPORTED_SCHEMA_VERSION')).toBe(true);
    expect(found.has('INVALID_EXPORTED_AT')).toBe(true);
    expect(found.has('FORBIDDEN_FIELD')).toBe(true);
    expect(found.has('DUPLICATE_ID')).toBe(true);
  });

  it('names where each problem is, so it can be found in the file', () => {
    const result = validateBackup({
      ...file(),
      collections: { financialEvents: [{ id: 'e-7', data: { amount: 1.5 } }] },
    });

    expect(result.problems[0]?.where).toBe('financialEvents/e-7.amount');
  });
});

/* ------------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------------ */

describe('planning an import', () => {
  const withRecords = () =>
    file({
      collections: {
        customers: [
          { id: 'c-1', data: {} },
          { id: 'c-2', data: {} },
        ],
        dresses: [{ id: 'd-1', data: {} }],
      },
    });

  it('counts creates and updates against what is already there', () => {
    const plan = planImport(withRecords(), { customers: new Set(['c-1']) });
    const customers = plan.find((entry) => entry.collection === 'customers');

    expect(customers).toMatchObject({ create: 1, update: 1, total: 2 });
  });

  it('counts everything as a create against an empty database', () => {
    const plan = planImport(withRecords(), {});

    expect(plan.find((entry) => entry.collection === 'customers')?.create).toBe(2);
    expect(plan.find((entry) => entry.collection === 'dresses')?.create).toBe(1);
  });

  it('omits collections the file does not carry', () => {
    const plan = planImport(withRecords(), {});

    expect(plan.map((entry) => entry.collection)).toEqual(['dresses', 'customers']);
  });

  it('lists collections in dependency order, so roots restore before leaves', () => {
    const everything = file({
      collections: Object.fromEntries(
        BACKUP_COLLECTIONS.map((name) => [name, [{ id: 'x', data: {} }]]),
      ) as BackupFile['collections'],
    });

    const plan = planImport(everything, {});
    const order = plan.map((entry) => entry.collection);

    expect(order.indexOf('customers' as BackupCollection)).toBeLessThan(
      order.indexOf('reservations' as BackupCollection),
    );
    expect(order.indexOf('reservations' as BackupCollection)).toBeLessThan(
      order.indexOf('financialEvents' as BackupCollection),
    );
  });

  it('totals the records in a file', () => {
    expect(totalRecordsIn(withRecords())).toBe(3);
    expect(totalRecordsIn(file())).toBe(0);
  });
});
