import { BookWithData, PageStat } from '@koinsight/common/types';
import { AreaChart } from '@mantine/charts';
import { Flex, Popover, Text, useComputedColorScheme, useMantineTheme } from '@mantine/core';
import { DatePicker } from '@mantine/dates';
import {
  IconArrowsVertical,
  IconCaretDownFilled,
  IconClock,
  IconPageBreak,
} from '@tabler/icons-react';
import {
  addDays,
  differenceInCalendarDays,
  endOfDay,
  endOfWeek,
  format,
  formatDate,
  getDay,
  isBefore,
  isSameDay,
  startOfDay,
  startOfWeek,
} from 'date-fns';
import { groupBy, sum } from 'ramda';
import { useMemo, useState } from 'react';
import { Statistics } from '../../components/statistics/statistics';
import { formatSecondsToHumanReadable } from '../../utils/dates';
import { getScaledPagesRead } from '../../utils/scaled-pages';

export function WeekStats({
  stats,
  booksByMd5,
}: {
  stats: PageStat[];
  booksByMd5: Record<string, BookWithData>;
}) {
  const colorScheme = useComputedColorScheme();
  const { colors } = useMantineTheme();

  const [weekStart, setWeekStart] = useState<number>(
    startOfWeek(new Date(), { weekStartsOn: 1 }).getTime()
  );

  const weekEnd = useMemo(() => {
    const rawWeekEnd = endOfWeek(weekStart, { weekStartsOn: 1 }).getTime();
    const today = endOfDay(new Date()).getTime();
    return rawWeekEnd <= today ? rawWeekEnd : today;
  }, [weekStart]);

  const weekData = useMemo(() => {
    const start = startOfWeek(weekStart, { weekStartsOn: 1 }).getTime();
    return stats?.filter(({ start_time }) => start_time < weekEnd && start_time > start);
  }, [stats, weekStart, weekEnd]);

  const weekDaysPassed = useMemo(
    () => differenceInCalendarDays(weekEnd, weekStart) + 1,
    [weekStart, weekEnd]
  );

  // Pages read on the canonical (per-book) scale, matching the server's
  // interval math: every row is projected onto `R = reference_pages ||
  // max(device pages)` and the union of the scaled intervals per day is taken.
  const pagesByDay = useMemo(() => {
    const grouped = groupBy((stat: PageStat) =>
      startOfDay(stat.start_time).getTime().toString()
    )(weekData ?? []);

    const result: Record<string, number> = {};
    for (const [day, dayStats] of Object.entries(grouped)) {
      const statsByBook = groupBy((stat: PageStat) => stat.book_md5)(dayStats ?? []);
      result[day] = sum(
        Object.entries(statsByBook).map(([md5, rows]) => {
          const book = booksByMd5[md5];
          return getScaledPagesRead(book, rows ?? [], book?.device_data);
        })
      );
    }
    return result;
  }, [weekData, booksByMd5]);

  const pagesRead = useMemo(() => Math.round(sum(Object.values(pagesByDay))), [pagesByDay]);

  const avgPagesPerDay = useMemo(() => {
    const values = Object.values(pagesByDay);
    return values.length > 0 ? Math.round(sum(values) / values.length) : 0;
  }, [pagesByDay]);

  const perDay = useMemo(() => {
    const perDayResult = [];

    let day = weekStart;
    while (isBefore(day, weekEnd)) {
      const dayStats = stats?.filter((stat) => isSameDay(stat.start_time, day)) ?? [];

      perDayResult.push({
        day: format(day, 'dd MMM yyyy'),
        duration: sum(dayStats.map((s) => s.duration)),
      });

      day = addDays(day, 1).getTime();
    }

    return perDayResult;
  }, [stats, weekStart, weekEnd]);

  return (
    <>
      <Popover position="bottom-start">
        <Popover.Target>
          <Flex align="center" mb="md" gap={4} style={{ cursor: 'pointer' }}>
            <Text c="violet.4" tt="uppercase" size="sm" fw={600}>
              {formatDate(weekStart, 'dd MMM')} - {formatDate(weekEnd, 'dd MMM')}
            </Text>
            <IconCaretDownFilled size={16} color={colors.violet[6]} />
          </Flex>
        </Popover.Target>
        <Popover.Dropdown>
          <DatePicker
            value={new Date(weekStart)}
            maxDate={endOfWeek(new Date(), { weekStartsOn: 1 })}
            onChange={(date) =>
              date && setWeekStart(startOfWeek(date, { weekStartsOn: 1 }).getTime())
            }
          />
        </Popover.Dropdown>
      </Popover>
      <Statistics
        data={[
          {
            label: 'Read time',
            value: formatSecondsToHumanReadable(sum(weekData?.map((stat) => stat.duration) ?? [])),
            icon: IconClock,
          },
          {
            label: 'Pages read',
            value: pagesRead,
            icon: IconPageBreak,
          },
          {
            label: 'Average pages per day',
            value: avgPagesPerDay,
            icon: IconArrowsVertical,
          },
          {
            label: 'Average time per day',
            value: formatSecondsToHumanReadable(
              Math.round(sum(weekData?.map((stat) => stat.duration) ?? []) / weekDaysPassed)
            ),
            icon: IconClock,
          },
        ]}
      />
      <AreaChart
        h={300}
        mt="sm"
        data={perDay}
        dataKey="day"
        gridAxis="none"
        withYAxis={false}
        type="stacked"
        valueFormatter={(value) => formatSecondsToHumanReadable(value)}
        curveType="monotone"
        series={[
          {
            name: 'duration',
            label: 'Reading time',
            color: colorScheme === 'dark' ? 'violet.3' : 'violet.7',
          },
        ]}
      />
    </>
  );
}
