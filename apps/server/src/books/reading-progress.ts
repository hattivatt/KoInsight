import { Book, BookDevice, PageStat } from '@koinsight/common/types';
import { normalizeRanges, Range, totalRangeLength } from '@koinsight/common/utils/ranges';
import { startOfDay } from 'date-fns';

/**
 * Single source of truth for page-count / reading-progress aggregation.
 *
 * The core problem: KOReader stores, per `page_stat` row, the *page number in
 * whatever pagination the device that produced the row was using*
 * (`page_stat.total_pages`). When the same book is read on two devices with
 * different paginations (e.g. 751 pages on a laptop and 1148 on a phone), raw
 * page numbers are not comparable: page 100 of the 751-page layout is a
 * different position in the book than page 100 of the 1148-page layout.
 *
 * To aggregate across devices we first project ("scale") every row onto a
 * canonical page count, the *scale* of the book, and only then union the
 * resulting intervals. The scale is `book.reference_pages` when the user (or
 * the ingest path) has set it, otherwise the widest pagination any device has
 * seen (`max(book_device.pages)`), otherwise the widest pagination present on
 * the rows themselves (legacy data with no `book_device` row).
 *
 * All functions here are pure and dependency-free so every call site
 * (`BooksService`, `BooksRepository`, `StatsService`) can share them.
 */

/**
 * Canonical page count ("scale") for a book. Returns 0 when no pagination
 * information is available at all (callers must handle 0 safely).
 *
 * Preference order:
 *   1. `book.reference_pages` — user-defined (or auto-filled at ingest).
 *   2. `max(book_device.pages)` — the widest pagination any device has seen.
 *   3. `max(page_stat.total_pages)` — legacy rows without a `book_device` row.
 */
export function getScale(
  book: Pick<Book, 'reference_pages'>,
  bookDevices: BookDevice[] = [],
  stats: PageStat[] = []
): number {
  if (book.reference_pages && book.reference_pages > 0) {
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
 * Project a single `page_stat` row onto a `Range` on the canonical scale.
 *
 * `page` is 1-based and a row represents the (half-open) span of the book that
 * was displayed, hence `[(page - 1) * scale / total_pages, page * scale / total_pages]`.
 * Returns `null` when the row's own pagination is unknown or the scale is
 * unknown (legacy rows with a missing/zero `total_pages`); callers decide how
 * to treat those rows separately.
 */
export function scaleStat(stat: PageStat, scale: number): Range | null {
  if (scale <= 0 || !stat.total_pages || stat.total_pages <= 0) {
    return null;
  }
  return [((stat.page - 1) * scale) / stat.total_pages, (stat.page * scale) / stat.total_pages];
}

/** Raw (unscaled) interval for a row, used only to rescue legacy rows. */
export function rawStat(stat: PageStat): Range {
  return [Math.max(stat.page - 1, 0), stat.page];
}

export function getTotalPages(book: Book, bookDevices: BookDevice[] = []): number {
  return getScale(book, bookDevices);
}

/**
 * Number of unique pages read, expressed on the canonical book scale.
 *
 * Every row is projected onto the scale first and the union of the resulting
 * intervals is measured. Rows with no usable pagination (`total_pages <= 0`)
 * are grouped separately and only fall back to raw page numbers when there are
 * no scaled rows at all, so legacy data still yields a number while valid data
 * is never distorted.
 */
export function getUniqueReadPages(
  book: Book,
  bookDevices: BookDevice[],
  stats: PageStat[]
): number {
  const scale = getScale(book, bookDevices, stats);
  const scaled: Range[] = [];
  const unscaled: Range[] = [];

  for (const stat of stats ?? []) {
    const range = scaleStat(stat, scale);
    if (range) {
      scaled.push(range);
    } else {
      unscaled.push(rawStat(stat));
    }
  }

  const ranges = scaled.length > 0 ? scaled : unscaled;
  return Math.round(totalRangeLength(normalizeRanges(ranges)));
}

/**
 * Furthest book position reached, expressed on the canonical scale
 * ("furthest position reached"). Rows that cannot be scaled fall back to their
 * raw page number so a number is still produced.
 */
export function getReadProgressPages(
  book: Book,
  bookDevices: BookDevice[],
  stats: PageStat[]
): number {
  const scale = getScale(book, bookDevices, stats);
  let max = 0;

  for (const stat of stats ?? []) {
    const end =
      scale > 0 && stat.total_pages > 0 ? (stat.page * scale) / stat.total_pages : stat.page;
    if (end > max) max = end;
  }

  return Math.round(max);
}

/**
 * Pages read per calendar day, on the canonical scale.
 *
 * Stats are grouped by book (each book has its own scale) and then by day; for
 * each day the union of the scaled intervals of that day's rows is measured.
 * The per-book scale is derived like everywhere else — `getScale(book,
 * bookDevices, group)` — so a book with no `reference_pages` still falls back to
 * the widest pagination of the devices it was read on (`max(book_device.pages)`).
 * `start_time` is expected in milliseconds (the shape returned by
 * `StatsRepository`).
 *
 * `bookDevices` is the flat list of `book_device` rows for the books in `stats`
 * (it can span several books; they are grouped by `book_md5` here).
 *
 * Returns one entry per day that has activity, in no particular order.
 */
export function getPagesPerDay(
  stats: PageStat[],
  books: Book[] = [],
  bookDevices: BookDevice[] = []
): number[] {
  const bookByMd5 = new Map<string, Book>();
  for (const book of books ?? []) bookByMd5.set(book.md5, book);

  const devicesByBook = new Map<string, BookDevice[]>();
  for (const device of bookDevices ?? []) {
    const list = devicesByBook.get(device.book_md5);
    if (list) list.push(device);
    else devicesByBook.set(device.book_md5, [device]);
  }

  const statsByBook = new Map<string, PageStat[]>();
  for (const stat of stats ?? []) {
    const group = statsByBook.get(stat.book_md5);
    if (group) group.push(stat);
    else statsByBook.set(stat.book_md5, [stat]);
  }

  const scaleByBook = new Map<string, number>();
  for (const [md5, group] of statsByBook) {
    const book = bookByMd5.get(md5) ?? { reference_pages: null };
    scaleByBook.set(md5, getScale(book, devicesByBook.get(md5) ?? [], group));
  }

  const rangesByDay = new Map<number, Range[]>();
  for (const stat of stats ?? []) {
    const scale = scaleByBook.get(stat.book_md5) ?? 0;
    const range = scaleStat(stat, scale) ?? rawStat(stat);
    const day = startOfDay(stat.start_time).getTime();
    const ranges = rangesByDay.get(day);
    if (ranges) ranges.push(range);
    else rangesByDay.set(day, [range]);
  }

  return [...rangesByDay.values()].map((ranges) => totalRangeLength(normalizeRanges(ranges)));
}
