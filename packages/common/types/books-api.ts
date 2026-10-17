import { Annotation } from './annotation.js';
import { Book } from './book.js';
import { BookDevice } from './book-device.js';
import { Genre } from './genre.js';
import { PageStat } from './page-stat.js';

type Stats = {
  last_open: number;
  total_read_time: number;
  total_pages: number;
  /**
   * Reading-event count (number of `page_stat` rows), NOT a page count. Kept for
   * API backwards compatibility; `unique_read_pages` / `read_progress_pages` are
   * the honest page figures.
   */
  total_read_pages: number;
  unique_read_pages: number;
  /** Furthest book position reached, expressed on the canonical page scale. */
  read_progress_pages: number;
  notes: number;
  highlights: number;
  read_per_day: Record<string, number>;
  started_reading: number;
  highlights_count: number;
  notes_count: number;
  bookmarks_count: number;
  deleted_count: number;
};

type RelatedEntities = {
  stats: PageStat[];
  device_data: BookDevice[];
  genres: Genre[];
  annotations: Annotation[];
};

export type BookWithData = Book & Stats & RelatedEntities;
