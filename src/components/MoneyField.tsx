import { useState } from 'react';

import { Field, type FieldProps } from '@/design-system';
import { toInputValue, tryParseOmr, type Baisa } from '@/domain/money';

export interface MoneyFieldProps extends Omit<FieldProps, 'value' | 'onChange' | 'type'> {
  readonly value: Baisa | null;
  readonly onChange: (value: Baisa | null) => void;
  readonly allowEmpty?: boolean;
}

interface Entry {
  /** The committed value this text corresponds to. */
  readonly source: Baisa | null;
  readonly text: string;
  readonly error: string | undefined;
}

/**
 * A currency input that never lets a float near the value.
 *
 * The employee types rials; the component emits `Baisa` integers. Parsing goes
 * through the money domain, so `180.0005` is rejected as a data-entry error
 * rather than silently rounded — OMR has no unit smaller than a baisa.
 *
 * The typed text is kept alongside the value it produced, so a half-finished
 * `"180."` is not reformatted mid-keystroke, while a value changed from outside
 * (loading a record to edit) still displays correctly.
 */
export function MoneyField({
  value,
  onChange,
  allowEmpty = false,
  error,
  ...rest
}: MoneyFieldProps) {
  const [entry, setEntry] = useState<Entry | null>(null);

  const text =
    entry !== null && entry.source === value
      ? entry.text
      : value === null
        ? ''
        : toInputValue(value);

  const localError = entry !== null && entry.source === value ? entry.error : undefined;

  function handleChange(next: string): void {
    if (next.trim().length === 0) {
      const committed = (allowEmpty ? null : 0) as Baisa | null;
      setEntry({ source: committed, text: next, error: undefined });
      onChange(committed);
      return;
    }

    const parsed = tryParseOmr(next);

    if (parsed === null) {
      // Keep the current committed value; show the text and the complaint.
      setEntry({ source: value, text: next, error: 'Enter an amount like 180.000' });
      return;
    }

    setEntry({ source: parsed, text: next, error: undefined });
    onChange(parsed);
  }

  return (
    <Field
      {...rest}
      // Not type="number": its spinners and locale-dependent decimal handling
      // get in the way of a fixed three-decimal currency.
      type="text"
      inputMode="decimal"
      value={text}
      onChange={(event) => handleChange(event.target.value)}
      error={error ?? localError}
      trailing={<span className="pe-1 text-xs text-ink-400">OMR</span>}
    />
  );
}
