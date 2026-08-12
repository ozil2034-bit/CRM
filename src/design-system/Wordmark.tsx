import { cn } from '@/lib/utils/cn';

export interface WordmarkProps {
  readonly size?: 'sm' | 'md' | 'lg';
  readonly showArabic?: boolean;
  readonly className?: string;
}

const SIZE_CLASSES = {
  sm: { en: 'text-lg', ar: 'text-sm', rule: 'w-8' },
  md: { en: 'text-2xl', ar: 'text-base', rule: 'w-12' },
  lg: { en: 'text-4xl', ar: 'text-xl', rule: 'w-16' },
} as const;

/**
 * The brand wordmark.
 *
 * English is set in Cormorant Garamond — the one place the display serif is used
 * without hesitation. Arabic is set in Noto Kufi, which shares the geometric
 * restraint of the Latin form. A single gold hairline separates them, and that
 * is the whole of the gold in the mark.
 */
export function Wordmark({ size = 'md', showArabic = true, className }: WordmarkProps) {
  const sizes = SIZE_CLASSES[size];

  return (
    <div className={cn('flex flex-col items-start', className)}>
      <span
        lang="en"
        className={cn('display leading-none tracking-[0.02em] text-ink-900', sizes.en)}
      >
        Azhary Boutique
      </span>

      <span aria-hidden="true" className={cn('rule-gold my-1.5', sizes.rule)} />

      {showArabic && (
        <span
          lang="ar"
          dir="rtl"
          className={cn('leading-none text-ink-600', sizes.ar)}
          style={{ fontFamily: 'var(--font-arabic-display)' }}
        >
          أزهاري بوتيك
        </span>
      )}
    </div>
  );
}
