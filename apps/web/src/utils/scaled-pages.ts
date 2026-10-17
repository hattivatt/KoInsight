import { Book, BookDevice, PageStat } from '@koinsight/common/types';
import { normalizeRanges, Range, totalRangeLength } from '@koinsight/common/utils/ranges';

export type { Range };

/**
 * Client-side equivalent of the server's canonical page-scale helpers
 * (`apps/server/src/books/reading-progress.ts`).
 *
 * KOReader records, per `page_stat` row, the page number in *that device's*
 * pagination (`page_stat.total_pages`). Page numbers are therefore not
 * comparable across devices with different layouts. Every row is projected
 * ("scaled") onto a canonical page count — the book's *scale* — before unions
 * are taken. This mirrors the server so week/daily numbers line up with the
 * per-book figures the API returns (`total_pages`, `unique_read_pages`,
 * `read_progress_pages`).
 */

type BookScaleInput = Pick<Book, 'reference_pages'>;

/**
 * Canonical page count ("scale") for a book, mirroring the server preference
 * order: `reference_pages` → widest device pagination → widest pagination seen
 * on the rows themselves. Returns 0 when nothing is known.
 */
export function getBookScale(
  book: BookScaleInput | undefined,
  bookDevices: ReadonlyArray<Pick<BookDevice, 'pages'>> = [],
  stats: ReadonlyArray<Pick<PageStat, 'total_pages'>> = []
): number {
  if (book?.reference_pages && book.reference_pages > 0) {
    return book.reference_pages;
  }

  let max = 0;
  for (const device of bookDevices ?? []) {
    if ((device.pages || 0) > max) max = device.pages || 0;
  }
  if (max > 0) return max;

  for (const stat of stats ?? []) {
    if ((stat.total_pages || 0) > max) max = stat.total_pages || 0;
  }
  return max;
}

/**
 * Project a single row onto a `Range` on the canonical scale:
 * `[(page - 1) * scale / total_pages, page * scale / total_pages]`.
 * Returns `null` when the row's own pagination or the scale is unknown.
 */
export function scaleStatRange(
  stat: Pick<PageStat, 'page' | 'total_pages'>,
  scale: number
): Range | null {
  if (scale <= 0 || !stat.total_pages || stat.total_pages <= 0) {
    return null;
  }
  return [((stat.page - 1) * scale) / stat.total_pages, (stat.page * scale) / stat.total_pages];
}

/** Raw (unscaled) interval, used only to rescue legacy rows with no pagination. */
function rawStatRange(stat: Pick<PageStat, 'page'>): Range {
  return [Math.max(stat.page - 1, 0), stat.page];
}

function statsToRanges(
  stats: ReadonlyArray<Pick<PageStat, 'page' | 'total_pages'>>,
  scale: number
): Range[] {
  return (stats ?? []).map((stat) => scaleStatRange(stat, scale) ?? rawStatRange(stat));
}

/**
 * Number of unique pages read for a set of rows, expressed on the book's
 * canonical scale.
 *
 * Mirrors the server's `getUniqueReadPages`: the fallback is *all-or-nothing*.
 * When at least one row carries usable pagination (`total_pages > 0`) only the
 * scaled intervals are unioned; raw page numbers are used only when no row can
 * be scaled at all. Mixing scaled and raw rows is never done, because raw page
 * numbers from a legacy row are not comparable to canonical-scale positions.
 */
export function getScaledPagesRead(
  book: BookScaleInput | undefined,
  stats: ReadonlyArray<Pick<PageStat, 'page' | 'total_pages'>>,
  bookDevices: ReadonlyArray<Pick<BookDevice, 'pages'>> = []
): number {
  const scale = getBookScale(book, bookDevices, stats);
  const scaled: Range[] = [];
  const unscaled: Range[] = [];

  for (const stat of stats ?? []) {
    const range = scaleStatRange(stat, scale);
    if (range) {
      scaled.push(range);
    } else {
      unscaled.push(rawStatRange(stat));
    }
  }

  const ranges = scaled.length > 0 ? scaled : unscaled;
  return Math.round(totalRangeLength(normalizeRanges(ranges)));
}

/**
 * Canonical-scale page range covered by a set of rows. Used for calendar day
 * tooltips, which the server does not provide on a per-day basis.
 */
export function getScaledPageRange(
  book: BookScaleInput | undefined,
  stats: ReadonlyArray<Pick<PageStat, 'page' | 'total_pages'>>,
  bookDevices: ReadonlyArray<Pick<BookDevice, 'pages'>> = []
): Range {
  const scale = getBookScale(book, bookDevices, stats);
  const ranges = normalizeRanges(statsToRanges(stats, scale));

  if (ranges.length === 0) {
    return [0, 0];
  }

  const start = Math.min(...ranges.map(([rangeStart]) => rangeStart));
  const end = Math.max(...ranges.map(([, rangeEnd]) => rangeEnd));
  return [start, end];
}
