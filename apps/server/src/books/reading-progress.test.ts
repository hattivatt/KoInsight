import { Book, KoReaderBook, PageStat } from '@koinsight/common/types';
import { range } from 'ramda';
import { db } from '../knex';
import { UploadService } from '../upload/upload-service';
import { BooksRepository } from './books-repository';
import { getReadProgressPages } from './reading-progress';

/**
 * Regression test for the reported two-device book:
 *
 *   - laptop: 751-page pagination, furthest page 435, 356 distinct pages read
 *     (all `total_pages = 751`)
 *   - phone:  1148-page pagination, furthest page 666, 138 distinct pages read
 *     (`total_pages ∈ {1148, 1038, 647, 643}`)
 *
 * The union of the RAW page numbers is only 396, yet the book has 1148
 * reference pages: merging raw page numbers compares incomparable positions and
 * wildly undercounts. After scaling every row onto the canonical 1148-page
 * pagination the union covers [0, 666], i.e. exactly 666 pages.
 */
const MD5 = 'twodevicebookmd5';

// --- The exact page sets used below -----------------------------------------
// laptop: {1..355} ∪ {435} = 356 pages
const LAPTOP_PAGES = [...range(1, 356), 435];
// phone: {1..47} ∪ {305..355} ∪ {627..666} = 47 + 51 + 40 = 138 pages
const PHONE_LOW_PAGES = range(1, 48);
const PHONE_MID_PAGES = range(305, 356); // overlaps the laptop set (51 pages)
const PHONE_HIGH_PAGES = range(627, 667);
const PHONE_PAGES = [...PHONE_LOW_PAGES, ...PHONE_MID_PAGES, ...PHONE_HIGH_PAGES];

// Raw union: 356 + 138 - 98 = 396
const RAW_UNION_SIZE = new Set([...LAPTOP_PAGES, ...PHONE_PAGES]).size;

function koreaderBook(pages: number): KoReaderBook {
  return {
    id: 1,
    md5: MD5,
    title: 'Two-Device Book',
    authors: 'A. Author',
    series: '',
    language: 'en',
    notes: 0,
    highlights: 0,
    last_open: 0,
    pages,
    total_read_time: 0,
    total_read_pages: 0,
  };
}

function makeStats(
  deviceId: string,
  rows: { page: number; totalPages: number }[],
  startTimeBase: number
): PageStat[] {
  return rows.map((row, i) => ({
    book_md5: MD5,
    device_id: deviceId,
    page: row.page,
    total_pages: row.totalPages,
    start_time: startTimeBase + i,
    duration: 10,
  }));
}

const PHONE_TP_CYCLE = [1148, 1038, 647, 643];

const PHONE_STATS = makeStats(
  'telefon',
  [
    // 47 low pages: every allowed pagination appears
    ...PHONE_LOW_PAGES.map((page, i) => ({
      page,
      totalPages: PHONE_TP_CYCLE[i % PHONE_TP_CYCLE.length],
    })),
    // 51 mid pages (overlap with the laptop set)
    ...PHONE_MID_PAGES.map((page) => ({ page, totalPages: 647 })),
    // 40 far pages, furthest position 666
    ...PHONE_HIGH_PAGES.map((page) => ({ page, totalPages: 1148 })),
  ],
  1_700_000_000
);

const LAPTOP_STATS = makeStats(
  'noutbuk',
  LAPTOP_PAGES.map((page) => ({ page, totalPages: 751 })),
  1_700_100_000
);

describe('two-device book regression', () => {
  it('has the expected synthetic page sets', () => {
    expect(LAPTOP_PAGES).toHaveLength(356);
    expect(PHONE_PAGES).toHaveLength(138);
    expect(RAW_UNION_SIZE).toEqual(396);
  });

  it('merges both devices onto the canonical 1148-page scale', async () => {
    // The 1148-page device uploads first, so the NULL-only auto-fill records
    // reference_pages = 1148; the later 751-page upload must not lower it.
    await UploadService.uploadStatisticData(
      [koreaderBook(1148)],
      PHONE_STATS,
      undefined,
      'telefon',
      'Телефон'
    );
    await UploadService.uploadStatisticData(
      [koreaderBook(751)],
      LAPTOP_STATS,
      undefined,
      'noutbuk',
      'Ноутбук'
    );

    const book = (await db<Book>('book').where({ md5: MD5 }).first()) as Book;
    expect(book.reference_pages).toEqual(1148); // auto-populated (Task 3)

    const [result] = await BooksRepository.getAllWithData();

    // Two distinct devices are kept apart (no more last-write-wins merge).
    expect(result.device_data).toHaveLength(2);
    expect(new Set(result.device_data.map((d) => d.device_id))).toEqual(
      new Set(['telefon', 'noutbuk'])
    );

    expect(result.total_pages).toEqual(1148);
    // 356 laptop rows + 138 phone rows
    expect(result.total_read_pages).toEqual(494);
    // The phone uploaded first and the laptop uploaded second; the laptop's
    // last event is page 435/751 -> 435 * 1148 / 751 ≈ 664.95 -> 665.
    // `read_progress_pages` is the CURRENT page (latest event), so the phone's
    // furthest page 666 must not win just because it is further along.
    expect(result.read_progress_pages).toEqual(665);
    // Scaled union covers [0, 666] exactly (raw union was only 396).
    expect(result.unique_read_pages).toEqual(666);
    expect(result.unique_read_pages).toBeGreaterThan(RAW_UNION_SIZE);
  });

  it('does not overwrite a user-set reference_pages', async () => {
    await UploadService.uploadStatisticData(
      [koreaderBook(1148)],
      PHONE_STATS,
      undefined,
      'telefon',
      'Телефон'
    );

    await db<Book>('book').where({ md5: MD5 }).update({ reference_pages: 500 });

    await UploadService.uploadStatisticData(
      [koreaderBook(751)],
      LAPTOP_STATS,
      undefined,
      'noutbuk',
      'Ноутбук'
    );

    const book = (await db<Book>('book').where({ md5: MD5 }).first()) as Book;
    expect(book.reference_pages).toEqual(500);
  });
});

describe(getReadProgressPages, () => {
  const book = { reference_pages: 1093 } as Book;

  function stat(page: number, start_time: number): PageStat {
    return {
      book_md5: 'footnote-book',
      device_id: 'device',
      page,
      total_pages: 1093,
      start_time,
      duration: 1,
    };
  }

  it('returns the latest reading event page, not the furthest page ever reached', () => {
    // Regression: jump to a footnote on page 961, then return to page 176.
    const stats = [stat(176, 1000), stat(961, 2000), stat(176, 3000)];

    expect(getReadProgressPages(book, [], stats)).toEqual(176);
  });

  it('breaks ties on the latest start_time using the highest scaled page', () => {
    // A reading-session row and a footnote row can share a timestamp.
    const stats = [stat(176, 3000), stat(961, 3000)];

    expect(getReadProgressPages(book, [], stats)).toEqual(961);
  });

  it('ignores a page-1 reset event recorded after real progress', () => {
    // Regression: KOReader reopened a partly read book at page 1 (lost reading
    // position), logged one short page-1 event, and the book went from
    // 913/2040 read back to 1/2040 in the UI.
    const stats = [stat(957, 1000), stat(1328, 2000), stat(1, 3000)];

    expect(getReadProgressPages(book, [], stats)).toEqual(1328);
  });

  it('does not let a page-1 reset on one device hide another device progress', () => {
    const scaledBook = { reference_pages: 2040 } as Book;
    const stats = [
      { ...stat(957, 1000), total_pages: 1281, device_id: 'laptop' },
      { ...stat(1328, 2000), total_pages: 2040, device_id: 'phone' },
      { ...stat(1, 3000), total_pages: 2040, device_id: 'phone' },
    ];

    // 1328 on the canonical 2040 scale, not the later page-1 reset.
    expect(getReadProgressPages(scaledBook, [], stats)).toEqual(1328);
  });

  it('still reports page 1 when it is the only reading event', () => {
    expect(getReadProgressPages(book, [], [stat(1, 1000)])).toEqual(1);
  });

  it('reports the latest start page when the book has only start pages', () => {
    expect(getReadProgressPages(book, [], [stat(1, 1000), stat(1, 2000)])).toEqual(1);
  });

  it('scales the latest row onto the canonical book scale', () => {
    const scaledBook = { reference_pages: 200 } as Book;
    const stats = [
      { ...stat(100, 1000), total_pages: 100 },
      { ...stat(50, 2000), total_pages: 100 },
    ];

    // 50 of a 100-page layout on a 200-page scale -> 100.
    expect(getReadProgressPages(scaledBook, [], stats)).toEqual(100);
  });

  it('returns 0 when there are no stats', () => {
    expect(getReadProgressPages(book, [], [])).toEqual(0);
  });
});
