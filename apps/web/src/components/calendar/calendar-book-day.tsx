import { BookWithData, PageStat } from '@koinsight/common/types';
import { Tooltip } from '@mantine/core';
import { IconClock } from '@tabler/icons-react';
import { sum } from 'ramda';
import { JSX } from 'react';
import { getDuration, shortDuration } from '../../utils/dates';
import { getScaledPageRange, getScaledPagesRead, Range } from '../../utils/scaled-pages';

type CalendarBookDayProps = {
  book: BookWithData;
  data: {
    events: PageStat[];
  };
};

function formatRange(range: Range, pagesRead: number): string {
  const start = Math.round(range[0]);
  const end = Math.round(range[1]);
  return `${start} - ${end} (${pagesRead} pages)`;
}

export function CalendarBookDay({ book, data }: CalendarBookDayProps): JSX.Element {
  const range = getScaledPageRange(book, data.events, book.device_data);
  // Count the union of the day's intervals, not the min–max envelope: a
  // footnote jump would otherwise inflate the page count.
  const pagesRead = getScaledPagesRead(book, data.events, book.device_data);
  const duration = getDuration(sum(data.events.map((event) => event.duration)));

  return (
    <Tooltip label={`Pages read: ${formatRange(range, pagesRead)}`}>
      <span>
        <IconClock size={14} /> {shortDuration(duration)}
      </span>
    </Tooltip>
  );
}
