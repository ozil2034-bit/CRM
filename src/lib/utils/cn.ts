/**
 * Conditional class name joiner.
 *
 * A dependency-free equivalent of `clsx` for the small surface we need: strings,
 * falsy values to skip, and `{ 'class': condition }` maps. The specification asks
 * for restraint with dependencies, and this is fourteen lines.
 */
export type ClassValue = string | number | false | null | undefined | Record<string, boolean>;

export function cn(...values: ClassValue[]): string {
  const classes: string[] = [];

  for (const value of values) {
    if (!value) continue;

    if (typeof value === 'string' || typeof value === 'number') {
      classes.push(String(value));
      continue;
    }

    for (const [name, enabled] of Object.entries(value)) {
      if (enabled) classes.push(name);
    }
  }

  return classes.join(' ');
}
