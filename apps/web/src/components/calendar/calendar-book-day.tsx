import { BookWithData, PageStat } from '@koinsight/common/types';
import { Tooltip } from '@mantine/core';
import { IconClock } from '@tabler/icons-react';
import { sum } from 'ramda';
import { JSX } from 'react';
import { getDuration, shortDuration } from '../../utils/dates';
import { getScaledPageRange, Range } from '../../utils/scaled-pages';

type CalendarBookDayProps = {
  book: BookWithData;
  data: {
    events: PageStat[];
  };
};

function formatRange(range: Range): string {
  const start = Math.round(range[0]);
  const end = Math.round(range[1]);
  return `${start} - ${end} (${end - start} pages)`;
}

export function CalendarBookDay({ book, data }: CalendarBookDayProps): JSX.Element {
  const [start, end] = getScaledPageRange(book, data.events, book.device_data);
  const duration = getDuration(sum(data.events.map((event) => event.duration)));

  return (
    <Tooltip label={`Pages read: ${formatRange([start, end])}`}>
      <span>
        <IconClock size={14} /> {shortDuration(duration)}
      </span>
    </Tooltip>
  );
}
