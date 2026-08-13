import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useT } from '@/hooks/useT';
import { searchCustomers, type Customer } from '@/services/customers.service';
import { searchDresses, type Dress } from '@/services/dresses.service';
import { displayName } from '@/domain/customer';
import { cn } from '@/lib/utils/cn';

/**
 * Global search across the boutique.
 *
 * Phase 3 covers customers and dresses. Reservations and invoices slot into the
 * same shape in later phases — the result list is already a discriminated union
 * so adding a kind does not restructure anything.
 *
 * Queries are indexed `array-contains` lookups with a bounded limit. The whole
 * collection is never downloaded to search it.
 */

type Result =
  | { readonly kind: 'dress'; readonly dress: Dress }
  | { readonly kind: 'customer'; readonly customer: Customer };

const DEBOUNCE_MS = 220;

export function GlobalSearch() {
  const { t, language } = useT();
  const navigate = useNavigate();

  const [term, setTerm] = useState('');
  const [outcome, setOutcome] = useState<{ term: string; results: Result[] } | null>(null);
  const [open, setOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  const trimmed = term.trim();

  /*
   * Results are keyed by the term that produced them, so "is this stale?" is
   * derived rather than reset. Clearing state when the term changes would mean a
   * synchronous setState in the effect and an extra render on every keystroke.
   */
  const results = outcome !== null && outcome.term === trimmed ? outcome.results : null;
  const searching = trimmed.length >= 2 && results === null;

  useEffect(() => {
    if (trimmed.length < 2) return;

    // Debounced so a query is not issued for every keystroke.
    const handle = setTimeout(() => {
      const id = ++requestId.current;

      void Promise.all([searchDresses(trimmed, 6), searchCustomers(trimmed, 6)])
        .then(([dresses, customers]) => {
          // Ignore a response that arrived after a newer query was issued.
          if (id !== requestId.current) return;

          setOutcome({
            term: trimmed,
            results: [
              ...customers.map((customer) => ({ kind: 'customer' as const, customer })),
              ...dresses.map((dress) => ({ kind: 'dress' as const, dress })),
            ],
          });
        })
        .catch(() => {
          if (id !== requestId.current) return;
          setOutcome({ term: trimmed, results: [] });
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [trimmed]);

  useEffect(() => {
    function handleClickAway(event: MouseEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickAway);
    return () => document.removeEventListener('mousedown', handleClickAway);
  }, []);

  function go(path: string): void {
    setOpen(false);
    setTerm('');
    setOutcome(null);
    navigate(path);
  }

  return (
    <div ref={containerRef} className="relative w-full max-w-xs">
      <input
        type="search"
        value={term}
        onChange={(event) => {
          setTerm(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={t('action.search')}
        aria-label={t('action.search')}
        className="h-10 w-full border-0 border-b border-ink-100 bg-transparent px-0 text-sm text-ink-900 placeholder:text-ink-300 focus:border-gold-500 focus:outline-none"
      />

      {open && trimmed.length >= 2 && (
        <div
          className={cn(
            'absolute inset-x-0 top-full z-20 mt-2 max-h-96 overflow-y-auto',
            'bg-white shadow-[--shadow-overlay]',
          )}
        >
          {searching && <p className="px-4 py-3 text-xs text-ink-400">…</p>}

          {!searching && results !== null && results.length === 0 && (
            <p className="px-4 py-3 text-xs text-ink-400">{t('inventory.noResults')}</p>
          )}

          {!searching &&
            results?.map((result) =>
              result.kind === 'customer' ? (
                <button
                  key={`c-${result.customer.id}`}
                  type="button"
                  onClick={() => go(`/customers/${result.customer.id}`)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-sand-50"
                >
                  <span className="w-16 shrink-0 font-mono text-2xs text-ink-300">
                    {result.customer.code}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                    {displayName(result.customer, language)}
                  </span>
                  <span className="label-caps shrink-0">{t('nav.customers')}</span>
                </button>
              ) : (
                <button
                  key={`d-${result.dress.id}`}
                  type="button"
                  onClick={() => go(`/inventory/${result.dress.id}`)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-sand-50"
                >
                  <span className="w-16 shrink-0 font-mono text-2xs text-ink-300">
                    {result.dress.code}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                    {result.dress.name}
                  </span>
                  <span className="label-caps shrink-0">{t('nav.inventory')}</span>
                </button>
              ),
            )}
        </div>
      )}
    </div>
  );
}
