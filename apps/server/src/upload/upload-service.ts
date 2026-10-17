import {
  Book,
  BookDevice,
  Device,
  KoReaderAnnotation,
  KoReaderBook,
  KoReaderPageStat,
  PageStat,
} from '@koinsight/common/types';
import { Knex } from 'knex';
import Database, { Database as DatabaseType } from 'better-sqlite3';
import { AnnotationsRepository } from '../annotations/annotations-repository';
import { db } from '../knex';
import { LEGACY_DEVICE_ID } from './device-resolution';

export class UploadService {
  static openStatisticsDbFile(uploadedFilePath: string) {
    const db = new Database(uploadedFilePath, { readonly: true });
    const bookIds = db.prepare('SELECT id FROM book').all();

    if (!bookIds.length) {
      throw new Error('No books found in the uploaded file');
    }

    return db;
  }

  /**
   * Extract books and page stats from a KOReader `statistics.sqlite3`.
   *
   * The KOReader schema has no device column, so every row is stamped with the
   * resolved `deviceId` (falling back to the legacy pseudo-device). Callers
   * that know the real device must pass it here or as the `deviceIdOverride`
   * argument of {@link uploadStatisticData}.
   */
  static extractDataFromStatisticsDb(db: DatabaseType, deviceId = LEGACY_DEVICE_ID) {
    const newBooks = db.prepare('SELECT * FROM book').all() as KoReaderBook[];
    const dbPageStats = db.prepare('SELECT * FROM page_stat_data').all() as KoReaderPageStat[];

    const newPageStats: PageStat[] = dbPageStats.map(({ id_book, ...stat }) => ({
      book_md5: newBooks.find((book) => book.id === id_book)!.md5,
      device_id: deviceId,
      ...stat,
    }));

    return { newBooks, newPageStats };
  }

  /**
   * Explicit, testable device-id precedence for an upload:
   *   1. `deviceIdOverride` — an explicit choice (form field / header / plugin body).
   *   2. the device id carried by the page stat rows (plugin sync path).
   *   3. the legacy `manual-upload` pseudo-device (backwards compatibility).
   *
   * It never assumes `manual-upload` is the only legacy device: any arbitrary
   * id may be passed and will be created if it does not exist yet.
   */
  static resolveDeviceId(pageStats: PageStat[], deviceIdOverride?: string): string {
    const override = deviceIdOverride?.trim();
    if (override) return override;

    const fromStats = pageStats.find((stat) => stat.device_id?.trim())?.device_id;
    if (fromStats) return fromStats;

    return LEGACY_DEVICE_ID;
  }

  /** Create the `device` row if missing. Existing rows keep their label. */
  private static async ensureDevice(
    trx: Knex.Transaction,
    deviceId: string,
    deviceLabel?: string
  ): Promise<void> {
    const existing = await trx<Device>('device').where({ id: deviceId }).first();
    if (existing) return;

    await trx<Device>('device').insert({
      id: deviceId,
      model: deviceLabel?.trim() || (deviceId === LEGACY_DEVICE_ID ? 'Manual Upload' : deviceId),
    });
  }

  /**
   * Auto-populate `book.reference_pages` from the devices seen so far.
   *
   * Only fills books whose `reference_pages` is still NULL, so a value set by
   * the user (or by `PUT /books/:id/reference_pages`) is never overwritten.
   * The derived value is `max(book_device.pages)` — the same derivation the
   * retro script uses.
   */
  private static async fillReferencePages(
    trx: Knex.Transaction,
    bookMd5s: string[]
  ): Promise<void> {
    for (const md5 of bookMd5s) {
      const row = (await trx('book_device')
        .where({ book_md5: md5 })
        .max('pages as maxPages')
        .first()) as { maxPages: number | null } | undefined;

      const maxPages = Number(row?.maxPages ?? 0);
      if (maxPages > 0) {
        await trx<Book>('book')
          .where({ md5 })
          .whereNull('reference_pages')
          .update({ reference_pages: maxPages });
      }
    }
  }

  static uploadStatisticData(
    booksToImport: KoReaderBook[],
    newPageStats: PageStat[],
    annotationsByBook?: Record<string, KoReaderAnnotation[]>,
    deviceIdOverride?: string, // explicit device id (upload form / plugin annotation sync)
    deviceLabel?: string // human label, used only when the device row is created
  ) {
    return db.transaction(async (trx) => {
      // Normalize: the plugin sends {} (empty Lua table → JSON object) on the
      // annotation-only path, not []. Guard all array operations against this,
      // and drop clearly invalid page stat rows.
      const safePageStats = (Array.isArray(newPageStats) ? newPageStats : []).filter(
        (s) =>
          s != null &&
          typeof s === 'object' &&
          Number.isFinite(s.duration) &&
          s.duration > 0 &&
          Number.isFinite(s.total_pages) &&
          s.total_pages > 0
      );
      // Insert books
      const newBooks: Partial<Book>[] = booksToImport.map((book) => ({
        id: book.id,
        md5: book.md5,
        title: book.title,
        authors: book.authors,
        series: book.series,
        language: book.language,
      }));

      await Promise.all(
        newBooks.map(({ id, ...book }) => trx<Book>('book').insert(book).onConflict('md5').ignore())
      );

      // Determine the device for this upload. Explicit override wins, then the
      // device id carried by the rows, then the legacy fallback (see
      // `resolveDeviceId`). Any id is accepted; the device row is created if it
      // does not exist yet, so arbitrary device ids work.
      const deviceId = this.resolveDeviceId(safePageStats, deviceIdOverride);

      if (deviceId === LEGACY_DEVICE_ID && !deviceIdOverride) {
        console.warn(
          `[upload] No device id provided for this import; falling back to the legacy ` +
            `"${LEGACY_DEVICE_ID}" pseudo-device. Pass a deviceId/deviceName field or an ` +
            `X-Device-Id header to attribute this data to a real device.`
        );
      }

      await this.ensureDevice(trx, deviceId, deviceLabel);

      const newBookDevices: Omit<BookDevice, 'id'>[] = booksToImport.map((book) => ({
        device_id: deviceId,
        book_md5: book.md5,
        last_open: book.last_open,
        pages: book.pages,
        notes: book.notes,
        highlights: book.highlights,
        total_read_pages: book.total_read_pages ?? 0,
        total_read_time: book.total_read_time ?? 0,
      }));

      await Promise.all(
        newBookDevices.map((bookDevice) => {
          const { book_md5, device_id, total_read_time, total_read_pages, ...otherFields } =
            bookDevice;

          // Always merge these fields (last_open added conditionally below)
          const fieldsToMerge: (keyof BookDevice)[] = ['pages', 'notes', 'highlights'];

          // Only merge last_open if it's a valid positive Unix timestamp (seconds)
          const last_open = bookDevice.last_open;
          if (Number.isFinite(last_open) && last_open > 0) {
            fieldsToMerge.push('last_open');
          }

          // Only merge statistics fields if they have actual values (if on statistics.db sync path)
          // This prevents annotation-only syncs from overwriting with zeros
          if (total_read_time !== undefined && total_read_time > 0) {
            fieldsToMerge.push('total_read_time');
          }
          if (total_read_pages !== undefined && total_read_pages > 0) {
            fieldsToMerge.push('total_read_pages');
          }

          return trx<BookDevice>('book_device')
            .insert(bookDevice)
            .onConflict(['book_md5', 'device_id'])
            .merge(fieldsToMerge);
        })
      );

      // Fill book.reference_pages for books that do not have one yet, using the
      // widest pagination seen so far. Runs after the book_device upsert so the
      // rows are visible. Never overwrites a user-set value.
      await this.fillReferencePages(
        trx,
        newBookDevices.map((bookDevice) => bookDevice.book_md5)
      );

      // Insert page stats (only on stats sync path! there are none for annotation sync path)
      if (safePageStats.length > 0) {
        await Promise.all(
          safePageStats.map((pageStat) =>
            trx<PageStat>('page_stat')
              // Every row belongs to the single device resolved above; this
              // keeps page_stat, book_device and annotation attribution aligned.
              .insert({ ...pageStat, device_id: deviceId })
              .onConflict(['device_id', 'book_md5', 'page', 'start_time'])
              .merge(['duration', 'total_pages'])
          )
        );
      }

      // Insert annotations if provided
      if (annotationsByBook) {
        await Promise.all(
          Object.entries(annotationsByBook).map(([bookMd5, annotations]) =>
            AnnotationsRepository.bulkInsert(bookMd5, deviceId, annotations, trx)
          )
        );

        // FIXME: with this, if there is only 1 annotation and it gets removed, it won't get marked as deleted, because `annotationsByBook` will be empty. It will only get marked as deleted if the user adds another annotation to trigger an update on the book.
        await Promise.all(
          Object.entries(annotationsByBook).map(([bookMd5, annotations]) =>
            this.detectAndMarkDeletedAnnotations(bookMd5, deviceId, annotations, trx)
          )
        );
      }

      await trx.commit();
    });
  }

  /**
   * Detect annotations that exist in the database but not in the sync data
   * These annotations were deleted in KoReader and should be marked as deleted
   *
   * @param bookMd5 - The book's MD5 hash
   * @param deviceId - The device ID
   * @param syncedAnnotations - Annotations received from KoReader
   * @param trx - Transaction to use
   */
  private static async detectAndMarkDeletedAnnotations(
    bookMd5: string,
    deviceId: string,
    syncedAnnotations: KoReaderAnnotation[],
    trx: any
  ): Promise<void> {
    // Get all existing non-deleted annotations for this book and device
    const existingAnnotations = await trx('annotation')
      .where({ book_md5: bookMd5, device_id: deviceId })
      .whereNull('deleted_at')
      .select('page_ref', 'datetime');

    // Create a Set of identifiers from synced annotations for fast lookup
    const syncedIdentifiers = new Set(syncedAnnotations.map((a) => `${a.page}|${a.datetime}`));

    // Find annotations that exist in DB but not in synced data
    const deletedAnnotations = existingAnnotations.filter(
      (a: { page_ref: string; datetime: string }) =>
        !syncedIdentifiers.has(`${a.page_ref}|${a.datetime}`)
    );

    if (deletedAnnotations.length > 0) {
      await AnnotationsRepository.markManyAsDeleted(bookMd5, deviceId, deletedAnnotations, trx);

      console.log(`Marked ${deletedAnnotations.length} annotations as deleted for book ${bookMd5}`);
    }
  }
}
