import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useT } from '@/hooks/useT';
import { searchCustomers, type Customer } from '@/services/customers.service';
import { searchDresses, type Dress } from '@/services/dresses.service';
import { searchReservations, type Reservation } from '@/services/reservations.service';
import { searchDocuments, type StoredDocument } from '@/services/documents.service';
import { displayName } from '@/domain/customer';
import { cn } from '@/lib/utils/cn';

/**
 * Global search across the boutique.
 *
 * Four kinds: customers, dresses, reservations and invoices. Results are
 * **grouped by kind** rather than interleaved — an employee searching "Fatima"
 * wants the customer, and one searching "RSV-0042" wants the booking; mixing
 * them by relevance score makes both harder to find.
 *
 * Every query is indexed and bounded. Customers and dresses use the
 * `searchTokens` array, which preserves the Arabic folding the search domain
 * establishes; reservations and invoices use a prefix range on their code,
 * because that is the only way anybody looks one up.
 *
 * The whole collection is never downloaded to search it.
 */

type Result =
  | { readonly kind: 'dress'; readonly dress: Dress }
  | { readonly kind: 'customer'; readonly customer: Customer }
  | { readonly kind: 'reservation'; readonly reservation: Reservation }
  | { readonly kind: 'document'; readonly document: StoredDocument };

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

      /*
       * `allSettled`, not `all`: an employee without permission to read invoices
       * would otherwise lose the customer and dress results too. One refused
       * query should cost only its own group.
       */
      void Promise.allSettled([
        searchDresses(trimmed, 6),
        searchCustomers(trimmed, 6),
        searchReservations(trimmed, 6),
        searchDocuments(trimmed, 6),
      ])
        .then(([dresses, customers, reservations, documents]) => {
          // Ignore a response that arrived after a newer query was issued.
          if (id !== requestId.current) return;

          const settled = <T,>(result: PromiseSettledResult<T[]>): T[] =>
            result.status === 'fulfilled' ? result.value : [];

          setOutcome({
            term: trimmed,
            results: [
              ...settled(customers).map((customer) => ({ kind: 'customer' as const, customer })),
              ...settled(dresses).map((dress) => ({ kind: 'dress' as const, dress })),
              ...settled(reservations).map((reservation) => ({
                kind: 'reservation' as const,
                reservation,
              })),
              ...settled(documents).map((document) => ({
                kind: 'document' as const,
                document,
              })),
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
            results !== null &&
            GROUPS.map((group) => {
              const rows = results.filter((result) => result.kind === group.kind);
              if (rows.length === 0) return null;

              return (
                <div key={group.kind}>
                  <p className="label-caps px-4 pt-3 pb-1">{t(group.labelKey)}</p>

                  {rows.map((result) => {
                    const row = describe(result, language);

                    return (
                      <button
                        key={`${result.kind}-${row.id}`}
                        type="button"
                        onClick={() => go(row.path)}
                        className="flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-sand-50"
                      >
                        <span className="w-20 shrink-0 font-mono text-2xs text-ink-300">
                          {row.code}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                          {row.title}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

/** The groups, in the order an employee scans them. */
const GROUPS = [
  { kind: 'customer' as const, labelKey: 'search.customers' as const },
  { kind: 'dress' as const, labelKey: 'search.dresses' as const },
  { kind: 'reservation' as const, labelKey: 'search.reservations' as const },
  { kind: 'document' as const, labelKey: 'search.invoices' as const },
];

/** One row's identity, whatever kind it is. */
function describe(
  result: Result,
  language: 'en' | 'ar',
): { id: string; code: string; title: string; path: string } {
  switch (result.kind) {
    case 'customer':
      return {
        id: result.customer.id,
        code: result.customer.code,
        title: displayName(result.customer, language),
        path: `/customers/${result.customer.id}`,
      };
    case 'dress':
      return {
        id: result.dress.id,
        code: result.dress.code,
        title: result.dress.name,
        path: `/inventory/${result.dress.id}`,
      };
    case 'reservation':
      return {
        id: result.reservation.id,
        code: result.reservation.code,
        title:
          language === 'ar' && result.reservation.customerNameAr.length > 0
            ? result.reservation.customerNameAr
            : result.reservation.customerName,
        path: `/reservations/${result.reservation.id}`,
      };
    case 'document':
      return {
        id: result.document.id,
        code: result.document.documentNumber,
        title: result.document.customer.nameEn,
        path: `/documents/${result.document.id}`,
      };
  }
}
