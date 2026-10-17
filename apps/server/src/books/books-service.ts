import { Book, BookDevice, BookWithData, PageStat } from '@koinsight/common/types';
import { startOfDay } from 'date-fns';
import { AnnotationsRepository } from '../annotations/annotations-repository';
import { GenreRepository } from '../genres/genre-repository';
import { StatsRepository } from '../stats/stats-repository';
import { BooksRepository } from './books-repository';
import {
  getReadProgressPages,
  getScale,
  getTotalPages,
  getUniqueReadPages,
} from './reading-progress';

export class BooksService {
  /**
   * Canonical page count ("scale") for a book. See `reading-progress.ts` for
   * the full rationale and preference order.
   */
  static getScale(book: Book, bookDevices: BookDevice[] = [], stats: PageStat[] = []): number {
    return getScale(book, bookDevices, stats);
  }

  static getTotalPages(book: Book, bookDevices: BookDevice[]): number {
    return getTotalPages(book, bookDevices);
  }

  static getTotalReadTime(bookDevices: BookDevice[]): number {
    return bookDevices.reduce((acc, device) => acc + device.total_read_time, 0);
  }

  static getStartedReading(stats: PageStat[]): number {
    if (stats.length === 0) return 0;
    return stats.reduce((acc, stat) => Math.min(acc, stat.start_time), Infinity);
  }

  static getLastOpen(bookDevices: BookDevice[]): number {
    return bookDevices.reduce((acc, device) => Math.max(acc, device.last_open), 0);
  }

  static getReadPerDay(stats: PageStat[]): Record<string, number> {
    return stats.reduce(
      (acc, stat) => {
        const day = startOfDay(stat.start_time).getTime();
        acc[day] = (acc[day] || 0) + stat.duration;

        return acc;
      },
      {} as Record<string, number>
    );
  }

  /**
   * Number of unique pages read, expressed on the canonical book scale.
   * Delegates to `reading-progress.ts` (single source of truth).
   */
  static getUniqueReadPages(book: Book, bookDevices: BookDevice[], stats: PageStat[]): number {
    return getUniqueReadPages(book, bookDevices, stats);
  }

  /**
   * Furthest book position reached, expressed on the canonical scale. For the
   * reported book this is 666: laptop's furthest page 435/751 -> 664.95,
   * phone's 666/1148 -> 666.
   */
  static getReadProgressPages(book: Book, bookDevices: BookDevice[], stats: PageStat[]): number {
    return getReadProgressPages(book, bookDevices, stats);
  }

  /**
   * Number of reading events recorded for a book.
   *
   * NOTE: despite the historical name this is NOT a page count — it simply counts
   * the `page_stat` rows. The honest page figures are `unique_read_pages` and
   * `read_progress_pages`. Retained for API backwards compatibility; the web UI
   * no longer renders it as "pages".
   */
  static getTotalReadPages(stats: PageStat[]): number {
    return stats.length;
  }

  static async withData(book: Book, includeDeleted = false): Promise<BookWithData> {
    const stats = await StatsRepository.getByBookMD5(book.md5);
    const bookDevices = await BooksRepository.getBookDevices(book.md5);
    const genres = await GenreRepository.getByBookMd5(book.md5);

    // Get annotations data
    const annotations = await AnnotationsRepository.getByBookMd5(book.md5);
    const annotationCounts = await AnnotationsRepository.getCountsByType(book.md5);
    const deletedCount = await AnnotationsRepository.getDeletedCount(book.md5);

    const total_pages = this.getTotalPages(book, bookDevices);
    const total_read_time = this.getTotalReadTime(bookDevices);
    const started_reading = this.getStartedReading(stats);
    const last_open = this.getLastOpen(bookDevices);
    const read_per_day = this.getReadPerDay(stats);
    const total_read_pages = this.getTotalReadPages(stats);
    const unique_read_pages = this.getUniqueReadPages(book, bookDevices, stats);
    const read_progress_pages = this.getReadProgressPages(book, bookDevices, stats);

    const response: BookWithData = {
      ...book,
      stats,
      device_data: bookDevices,
      started_reading,
      read_per_day,
      total_read_time,
      total_read_pages,
      unique_read_pages,
      read_progress_pages,
      total_pages,
      last_open,
      genres,
      notes: bookDevices.reduce((acc, device) => acc + device.notes, 0),
      highlights: bookDevices.reduce((acc, device) => acc + device.highlights, 0),
      // Annotation data
      annotations,
      highlights_count: annotationCounts.highlight,
      notes_count: annotationCounts.note,
      bookmarks_count: annotationCounts.bookmark,
      deleted_count: deletedCount,
    };

    return response;
  }
}
