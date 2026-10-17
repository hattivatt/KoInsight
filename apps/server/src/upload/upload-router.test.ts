import Database from 'better-sqlite3';
import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { appConfig } from '../config';
import { db } from '../knex';
import { uploadRouter } from './upload-router';

const app = express();
app.use('/upload', uploadRouter);

/** Minimal KOReader `statistics.sqlite3` with one book and one page stat row. */
function makeStatisticsDb(file: string, md5: string, pages: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const src = new Database(file);
  src.exec(`
    CREATE TABLE book (
      id INTEGER PRIMARY KEY, title TEXT, authors TEXT, notes INTEGER,
      last_open INTEGER, highlights INTEGER, pages INTEGER, series TEXT,
      language TEXT, md5 TEXT, total_read_time INTEGER, total_read_pages INTEGER
    );
    CREATE TABLE page_stat_data (
      id INTEGER PRIMARY KEY, id_book INTEGER, page INTEGER,
      start_time INTEGER, duration INTEGER, total_pages INTEGER
    );
  `);
  src
    .prepare('INSERT INTO book VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(1, 'Two-Device Book', 'A. Author', 0, 0, 0, pages, '', 'en', md5, 0, 0);
  src
    .prepare('INSERT INTO page_stat_data VALUES (?,?,?,?,?,?)')
    .run(1, 1, 10, 1_700_000_000, 30, pages);
  src.close();
}

describe('upload-router device attribution', () => {
  let file: string;

  beforeEach(() => {
    // Ensure the multer destination exists regardless of the host environment.
    fs.mkdirSync(appConfig.dataPath, { recursive: true });
    file = path.join(os.tmpdir(), `koinsight-upload-${Date.now()}-${Math.random()}.sqlite3`);
  });

  afterEach(() => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  it('derives a stable device id from the deviceName field', async () => {
    const md5 = 'router-device-name-md5';
    makeStatisticsDb(file, md5, 300);

    const response = await request(app)
      .post('/upload')
      .field('deviceName', 'Ноутбук')
      .attach('file', file);

    expect(response.status).toBe(200);

    const device = await db('device').where({ id: 'noutbuk' }).first();
    expect(device).toEqual(expect.objectContaining({ id: 'noutbuk', model: 'Ноутбук' }));

    const stat = await db('page_stat').where({ book_md5: md5 }).first();
    expect(stat).toEqual(expect.objectContaining({ device_id: 'noutbuk', page: 10 }));

    const bookDevice = await db('book_device').where({ book_md5: md5 }).first();
    expect(bookDevice).toEqual(expect.objectContaining({ device_id: 'noutbuk', pages: 300 }));

    const book = await db('book').where({ md5 }).first();
    expect(book.reference_pages).toEqual(300);
  });

  it('uses an explicit deviceId field', async () => {
    const md5 = 'router-device-id-md5';
    makeStatisticsDb(file, md5, 300);

    const response = await request(app)
      .post('/upload')
      .field('deviceId', 'my-existing-device')
      .attach('file', file);

    expect(response.status).toBe(200);

    const stat = await db('page_stat').where({ book_md5: md5 }).first();
    expect(stat).toEqual(expect.objectContaining({ device_id: 'my-existing-device' }));

    const device = await db('device').where({ id: 'my-existing-device' }).first();
    expect(device).toBeTruthy();
  });

  it('uses the X-Device-Id header as a fallback', async () => {
    const md5 = 'router-header-md5';
    makeStatisticsDb(file, md5, 300);

    const response = await request(app)
      .post('/upload')
      .set('X-Device-Id', 'header-device')
      .attach('file', file);

    expect(response.status).toBe(200);

    const stat = await db('page_stat').where({ book_md5: md5 }).first();
    expect(stat).toEqual(expect.objectContaining({ device_id: 'header-device' }));
  });

  it('falls back to the legacy manual-upload device when nothing is provided', async () => {
    const md5 = 'router-legacy-md5';
    makeStatisticsDb(file, md5, 300);

    const response = await request(app).post('/upload').attach('file', file);

    expect(response.status).toBe(200);

    const stat = await db('page_stat').where({ book_md5: md5 }).first();
    expect(stat).toEqual(expect.objectContaining({ device_id: 'manual-upload' }));
  });
});
