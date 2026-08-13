import { describe, it, expect } from 'vitest';
import { buildAuditRecord, summariseChange } from './audit.service';

const actor = { uid: 'staff-1', name: 'Fatima', role: 'STAFF' } as const;

describe('summariseChange()', () => {
  it('records only the fields that actually changed', () => {
    // A full document copy per edit would grow without bound and bury the
    // change the entry exists to describe.
    const { before, after } = summariseChange(
      { name: 'Aurora', designer: 'Elie Saab', rentalPrice: 180_000 },
      { name: 'Aurora II', designer: 'Elie Saab', rentalPrice: 180_000 },
    );

    expect(before).toEqual({ name: 'Aurora' });
    expect(after).toEqual({ name: 'Aurora II' });
  });

  it('records nothing when nothing changed', () => {
    const { before, after } = summariseChange({ name: 'Aurora' }, { name: 'Aurora' });
    expect(before).toEqual({});
    expect(after).toEqual({});
  });

  it('detects changes inside nested objects', () => {
    const { after } = summariseChange(
      { measurements: { bust: 86, waist: 70 } },
      { measurements: { bust: 88, waist: 70 } },
    );
    expect(after).toHaveProperty('measurements');
  });

  it('redacts the national ID — it identifies a person to the state', () => {
    const { before, after } = summariseChange(
      { nationalId: '1234567', nameEn: 'Fatima' },
      { nationalId: '7654321', nameEn: 'Fatima' },
    );

    expect(before).toEqual({ nationalId: '[redacted]' });
    expect(after).toEqual({ nationalId: '[redacted]' });
    expect(JSON.stringify({ before, after })).not.toContain('1234567');
  });

  it('redacts notes, measurements and email but still records that they changed', () => {
    // The auditable event is "this field was edited", not its contents.
    const { after } = summariseChange(
      { notes: 'private remark', email: 'a@b.com' },
      { notes: 'another private remark', email: 'c@d.com' },
    );

    expect(after).not.toBeNull();
    expect(after?.['notes']).toBe('[redacted]');
    expect(after?.['email']).toBe('[redacted]');
    expect(JSON.stringify(after)).not.toContain('private remark');
    expect(JSON.stringify(after)).not.toContain('a@b.com');
  });

  it('never records search tokens', () => {
    const { after } = summariseChange(
      { searchTokens: ['fa', 'fat'] },
      { searchTokens: ['no', 'noo'] },
    );
    expect(after?.['searchTokens']).toBe('[redacted]');
  });

  it('redacts on creation, where there is no before', () => {
    const { before, after } = summariseChange(null, {
      code: 'CU-0001',
      nationalId: '1234567',
    });

    expect(before).toBeNull();
    expect(after).toEqual({ code: 'CU-0001', nationalId: '[redacted]' });
  });

  it('reports an added field as a change from null', () => {
    const { before, after } = summariseChange({ name: 'Aurora' }, { name: 'Aurora', size: '38' });
    expect(before).toEqual({ size: null });
    expect(after).toEqual({ size: '38' });
  });
});

describe('buildAuditRecord()', () => {
  it('records who, what and which entity', () => {
    const record = buildAuditRecord({
      actor,
      action: 'dress.created',
      entityType: 'dress',
      entityId: 'd1',
      entityCode: 'WD-0001',
      before: null,
      after: { code: 'WD-0001' },
    });

    expect(record).toMatchObject({
      actorUid: 'staff-1',
      actorName: 'Fatima',
      actorRole: 'STAFF',
      action: 'dress.created',
      entityType: 'dress',
      entityId: 'd1',
      entityCode: 'WD-0001',
    });
  });

  it('carries the actor uid the rules will check against the caller', () => {
    // firestore.rules requires actorUid == request.auth.uid, so an entry cannot
    // be forged against another employee.
    const record = buildAuditRecord({
      actor,
      action: 'customer.archived',
      entityType: 'customer',
      entityId: 'c1',
      entityCode: 'CU-0001',
    });

    expect(record['actorUid']).toBe(actor.uid);
  });

  it('stores a reason when given and null when not', () => {
    const withReason = buildAuditRecord({
      actor,
      action: 'dress.retired',
      entityType: 'dress',
      entityId: 'd1',
      entityCode: 'WD-0001',
      reason: 'Damaged beyond repair',
    });
    expect(withReason['reason']).toBe('Damaged beyond repair');

    const without = buildAuditRecord({
      actor,
      action: 'dress.retired',
      entityType: 'dress',
      entityId: 'd1',
      entityCode: 'WD-0001',
    });
    expect(without['reason']).toBeNull();
  });
});
