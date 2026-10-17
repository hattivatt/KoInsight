import { Book } from './book.js';
import { Device } from './device.js';

export type BookDevice = {
  id: number;
  book_md5: Book['md5'];
  device_id: Device['id'];
  last_open: number;
  notes: number;
  highlights: number;
  pages: number;
  total_read_time: number;
  total_read_pages: number;
};
