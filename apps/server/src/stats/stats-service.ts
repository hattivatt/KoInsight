import {
  Book,
  BookDevice,
  BookWithData,
  PageStat,
  PerDayOfTheWeek,
  PerMonthReadingTime,
} from '@koinsight/common/types';
import { format, startOfDay, subDays } from 'date-fns';
import { sum } from 'ramda';
import { getPagesPerDay } from '../books/reading-progress';

export class StatsService {
  static getPerMonthReadingTime(stats: PageStat[]): PerMonthReadingTime[] {
    const perMonth = (stats ?? [])
      .reduce<PerMonthReadingTime[]>((acc, stat) => {
        const month = format(stat.start_time, 'MMMM yyyy');
        const monthData = acc.find((item) => item.month === month);
        if (monthData) {
          monthData.duration += stat.duration;
        } else {
          acc.push({ month, duration: stat.duration, date: stat.start_time });
        }

        return acc;
      }, [])
      .sort((a, b) => a.date - b.date);

    return perMonth;
  }

  static perDayOfTheWeek(stats: PageStat[]): PerDayOfTheWeek[] {
    return stats
      .reduce((acc, stat) => {
        const day = format(stat.start_time, 'EEEE');
        const existingDay = acc.find((d) => d.name === day);
        if (existingDay) {
          existingDay.value += stat.duration;
        } else {
          acc.push({
            name: day,
            value: stat.duration,
            day: new Date(stat.start_time).getUTCDay(),
          });
        }
        return acc;
      }, [] as PerDayOfTheWeek[])
      .sort((a, b) => a.day - b.day);
  }

  static mostPagesInADay(books: Book[], stats: PageStat[], bookDevices: BookDevice[] = []) {
    const max = Math.round(Math.max(...this.getPagesPerDay(stats, books, bookDevices)));
    return Math.max(0, max);
  }

  static totalReadingTime(stats: PageStat[]) {
    return sum((stats ?? []).map((s) => s.duration));
  }

  static longestDay(stats: PageStat[]) {
    const timePerDay = stats.reduce<Record<number, number>>((acc, stat) => {
      const day = startOfDay(stat.start_time).getTime();
      acc[day] = (acc[day] || 0) + stat.duration;
      return acc;
    }, {});

    const maxTime = Math.max(...Object.values(timePerDay ?? []));
    return Math.max(0, maxTime);
  }

  static last7DaysReadTime(stats: PageStat[]) {
    const sevenDaysAgo = subDays(new Date(), 7);
    const lastSevenDays = stats.filter((stat) => stat.start_time > sevenDaysAgo.getTime());
    return sum(lastSevenDays.map((s) => s.duration));
  }

  /**
   * Named for historical reasons: this now sums `total_read_pages`, which is a
   * reading-EVENT count (number of `page_stat` rows) and not a page count. The
   * honest page figures per book are `unique_read_pages` / `read_progress_pages`.
   */
  static totalPagesRead(books: BookWithData[]) {
    return books.reduce((acc, book) => acc + book.total_read_pages, 0);
  }

  /**
   * Pages read per day on the canonical (per-book) scale — union of scaled
   * intervals per day. Delegates to `reading-progress.ts` (single source of
   * truth shared with the book aggregation). `bookDevices` lets the scale fall
   * back to `max(book_device.pages)`, matching the web week-stats figures.
   */
  private static getPagesPerDay(stats: PageStat[], books: Book[], bookDevices: BookDevice[] = []) {
    return getPagesPerDay(stats, books, bookDevices);
  }
}
