/**
 * retro-assign-devices.ts
 *
 * One-off retro-migration script (NOT a knex migration).
 *
 * Problem it fixes
 * ----------------
 * The manual `statistics.sqlite3` upload path in KoInsight hard-codes
 * `device_id = 'manual-upload'` (see `src/upload/upload-service.ts`). When a
 * user uploads per-device KOReader statistics DBs from more than one device,
 * all of their `page_stat` rows collapse onto a single `manual-upload` device,
 * and the `book_device` row is last-upload-wins. The original KOReader
 * statistics DBs are the ground truth for re-attributing these rows.
 *
 * What it does
 * ------------
 *  1. Opens the KoInsight SQLite DB and every `--source` KOReader DB read-only
 *     (unless `--apply`, which writes and makes a backup first).
 *  2. Builds, per source, a map:  md5 -> { pages, total_read_pages,
 *     total_read_time, last_open, notes, highlights } and
 *     md5 -> (page|start_time) -> { duration, total_pages }.
 *  3. Walks every `page_stat` row currently on `manual-upload` whose book md5
 *     appears in at least one source, and assigns it to the matching source
 *     device. Unmatched rows stay on `manual-upload` and are reported.
 *  4. Upserts a `device` row per source (id derived from the label, `model` =
 *     label) and a `book_device` row per (book, source) using the source DB's
 *     own `book` values, replacing the last-write-wins merge.
 *  5. Optionally (`--set-reference-pages`) fills `book.reference_pages` with the
 *     max `book_device.pages` across the reconstructed devices, but only for
 *     books whose `reference_pages` is still NULL (never overwrites a
 *     user-set value — mirrors the ingest guard).
 *
 * TIMESTAMPS: KOReader stores `start_time` in seconds. KoInsight *stores* the
 * same seconds value; the x1000 conversion lives only in the read path
 * (`StatsRepository.updateStartTime`). This script therefore joins on
 * `start_time` directly, with a defensive `/1000` fallback if some rows were
 * ever stored in milliseconds.
 *
 * Usage: see `--help`.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SourceBook = {
  title: string;
  notes: number;
  highlights: number;
  pages: number;
  totalReadPages: number;
  totalReadTime: number;
  lastOpen: number;
};

type SourceRow = {
  duration: number;
  totalPages: number;
};

type Source = {
  label: string;
  deviceId: string;
  absPath: string;
  db: Database.Database;
  books: Map<string, SourceBook>;
  /** md5 -> `${page}|${startTime}` -> row */
  rows: Map<string, Map<string, SourceRow>>;
  rowCount: number;
};

type KoInsightPageStat = {
  id: number;
  book_md5: string;
  page: number;
  start_time: number;
  duration: number;
  total_pages: number;
};

type Assignment = {
  rowId: number;
  bookMd5: string;
  deviceId: string | null;
  ambiguous: boolean;
  /** source used a scaled (/1000) start_time */
  scaledTime: boolean;
  /** matched on page+time but total_pages differed */
  totalPagesMismatch: boolean;
};

type BookAgg = {
  md5: string;
  title: string;
  total: number;
  perDevice: Map<string, number>;
  unmatched: number;
  ambiguous: number;
};

type ExistingBookDevice = {
  pages: number;
  total_read_pages: number;
  total_read_time: number;
  last_open: number;
};

type Options = {
  dbPath: string;
  sources: { rawPath: string; label: string }[];
  idOverrides: Map<string, string>;
  apply: boolean;
  forceProd: boolean;
  setReferencePages: boolean;
  keepMergedBookDevice: boolean;
  help: boolean;
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const DEFAULT_DB = path.join(os.homedir(), '.local/share/koinsight/prod.sqlite3');
/**
 * Well-known production database location. `--apply` refuses to write here
 * unless `--force-prod` is passed (dry-run is always allowed, it is read-only).
 */
const PROD_DB = DEFAULT_DB;
const UNKNOWN_DEVICE_ID = 'manual-upload';

function usage(): string {
  return `
retro-assign-devices - reconstruct per-device attribution for already-uploaded
KOReader data, using the original KOReader statistics DBs as source of truth.

USAGE
  npm --workspace=server run retro-devices -- \\
      --source <koReader.sqlite3>=<Label> [--source ...] \\
      [--id <Label>=<device-id> ...] \\
      [--db <koinsight.sqlite3>] \\
      [--dry-run | --apply]

OPTIONS
  --source <path>=<Label>   KOReader statistics DB and the human label of the
                            device it came from. Repeatable, once per device.
                            The DB is opened READ-ONLY. If '=<Label>' is
                            omitted, the file's basename (without extension) is
                            used as the label.
  --id <Label>=<id>         Override the derived device id for a label.
                            Repeatable.
  --db <path>               KoInsight SQLite DB.
                            Default: ${DEFAULT_DB}
  --dry-run                 Report what would change, write nothing. DEFAULT.
  --apply                   Write changes. FIRST copies the KoInsight DB to
                            '<db>.bak-<ISO timestamp>' right next to it and
                            prints the backup path. Writing to the production
                            DB requires --force-prod. Dry-run is always safe.
  --force-prod              Allow --apply to write to the production DB
                            (${PROD_DB}). A backup is still made first.
  --set-reference-pages     After reconstruction, fill book.reference_pages for
                            touched books that still have it NULL, with the max
                            book_device.pages across their reconstructed
                            devices. Never overwrites a user-set value. OFF by
                            default (the ingest path auto-fills it).
  --keep-merged-book-device Do NOT delete the now-superseded 'manual-upload'
                            book_device rows for books that were fully
                            re-attributed. OFF by default (they are removed).
  -h, --help                Show this help.

DEVICE ID DERIVATION
  By default a device id is derived deterministically from the label by
  transliterating Cyrillic to Latin and slugifying: "Ноутбук" -> "noutbuk",
  "Телефон" -> "telefon". Use --id to override, e.g. --source ...=Ноутбук
  --id Ноутбук=laptop. Ids must be unique and must not be 'manual-upload'.

SCOPE
  Only rows whose book md5 appears in at least one --source DB are touched.
  Rows that match no source stay on 'manual-upload' and are reported; their
  book's 'manual-upload' book_device row is kept.

EXIT CODES
  0  success (ambiguities/unmatched rows are warnings only)
  1  fatal error (bad args, unreadable DB, etc.)
`.trimStart();
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    dbPath: DEFAULT_DB,
    sources: [],
    idOverrides: new Map(),
    apply: false,
    forceProd: false,
    setReferencePages: false,
    keepMergedBookDevice: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    const inlineValue = arg.startsWith('--') && eq !== -1 ? arg.slice(eq + 1) : undefined;

    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[++i];
      if (next === undefined) throw new Error(`Option ${name} requires a value`);
      return next;
    };

    switch (name) {
      case '--source': {
        const raw = takeValue();
        const sep = raw.lastIndexOf('=');
        let rawPath: string;
        let label: string;
        if (sep > 0) {
          rawPath = raw.slice(0, sep);
          label = raw.slice(sep + 1).trim();
        } else {
          rawPath = raw;
          label = path.basename(raw, path.extname(raw));
        }
        if (!rawPath || !label) throw new Error(`Invalid --source value: ${raw}`);
        opts.sources.push({ rawPath, label });
        break;
      }
      case '--id': {
        const raw = takeValue();
        const sep = raw.indexOf('=');
        if (sep <= 0) throw new Error(`Invalid --id value (expected <Label>=<id>): ${raw}`);
        opts.idOverrides.set(raw.slice(0, sep).trim(), raw.slice(sep + 1).trim());
        break;
      }
      case '--db':
        opts.dbPath = takeValue();
        break;
      case '--apply':
        opts.apply = true;
        break;
      case '--dry-run':
        opts.apply = false;
        break;
      case '--force-prod':
        opts.forceProd = true;
        break;
      case '--set-reference-pages':
        opts.setReferencePages = true;
        break;
      case '--keep-merged-book-device':
        opts.keepMergedBookDevice = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Device id derivation (Cyrillic transliteration + slugify)
// ---------------------------------------------------------------------------

const CYRILLIC: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  // Ukrainian / additional
  і: 'i',
  ї: 'yi',
  є: 'ye',
  ґ: 'g',
};

function slugify(label: string): string {
  let transliterated = '';
  for (const ch of label.toLowerCase()) {
    transliterated += CYRILLIC[ch] !== undefined ? CYRILLIC[ch] : ch;
  }
  const slug = transliterated
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'device';
}

// ---------------------------------------------------------------------------
// Source loading
// ---------------------------------------------------------------------------

function loadSource(rawPath: string, label: string, deviceId: string): Source {
  const absPath = path.resolve(rawPath);
  if (!fs.existsSync(absPath)) throw new Error(`Source DB not found: ${absPath}`);

  const db = new Database(absPath, { readonly: true, fileMustExist: true });

  const bookRows = db
    .prepare(
      `SELECT md5, title, notes, highlights, pages, total_read_pages, total_read_time, last_open
       FROM book WHERE md5 IS NOT NULL`
    )
    .all() as {
    md5: string;
    title: string | null;
    notes: number | null;
    highlights: number | null;
    pages: number | null;
    total_read_pages: number | null;
    total_read_time: number | null;
    last_open: number | null;
  }[];

  const books = new Map<string, SourceBook>();
  for (const b of bookRows) {
    books.set(b.md5, {
      title: b.title ?? '',
      notes: b.notes ?? 0,
      highlights: b.highlights ?? 0,
      pages: b.pages ?? 0,
      totalReadPages: b.total_read_pages ?? 0,
      totalReadTime: b.total_read_time ?? 0,
      lastOpen: b.last_open ?? 0,
    });
  }

  const statRows = db
    .prepare(
      `SELECT b.md5 AS md5, p.page AS page, p.start_time AS start_time,
              p.duration AS duration, p.total_pages AS total_pages
       FROM page_stat_data p JOIN book b ON b.id = p.id_book`
    )
    .all() as {
    md5: string;
    page: number;
    start_time: number;
    duration: number;
    total_pages: number;
  }[];

  const rows = new Map<string, Map<string, SourceRow>>();
  for (const r of statRows) {
    let byKey = rows.get(r.md5);
    if (!byKey) {
      byKey = new Map();
      rows.set(r.md5, byKey);
    }
    byKey.set(`${r.page}|${r.start_time}`, {
      duration: r.duration,
      totalPages: r.total_pages,
    });
  }

  return { label, deviceId, absPath, db, books, rows, rowCount: statRows.length };
}

/** KOReader seconds; defensively also try /1000 in case a row was stored in ms. */
function candidateStartTimes(startTime: number): number[] {
  const out = [startTime];
  if (startTime !== 0 && startTime % 1000 === 0 && Math.abs(startTime) >= 1e9) {
    out.push(startTime / 1000);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function matchRow(
  row: KoInsightPageStat,
  sources: Source[]
): {
  deviceId: string | null;
  ambiguous: boolean;
  scaledTime: boolean;
  totalPagesMismatch: boolean;
} {
  const candidates: { src: Source; sr: SourceRow; scaled: boolean }[] = [];

  for (const src of sources) {
    const byKey = src.rows.get(row.book_md5);
    if (!byKey) continue;
    for (const t of candidateStartTimes(row.start_time)) {
      const sr = byKey.get(`${row.page}|${t}`);
      if (sr) {
        candidates.push({ src, sr, scaled: t !== row.start_time });
        break;
      }
    }
  }

  if (candidates.length === 0) {
    return { deviceId: null, ambiguous: false, scaledTime: false, totalPagesMismatch: false };
  }

  // Prefer candidates whose total_pages matches exactly (the row's intrinsic
  // page count). Only fall back if none match.
  let pool = candidates.filter((c) => c.sr.totalPages === row.total_pages);
  const totalPagesMismatch = pool.length === 0;
  if (totalPagesMismatch) pool = candidates;

  // Tie-break by duration (the reading-event length).
  let ambiguous = false;
  if (pool.length > 1) {
    const byDuration = pool.filter((c) => c.sr.duration === row.duration);
    if (byDuration.length === 1) {
      pool = byDuration;
    } else {
      ambiguous = true; // first --source argument wins (pool is in arg order)
    }
  }

  const chosen = pool[0];
  return {
    deviceId: chosen.src.deviceId,
    ambiguous,
    scaledTime: chosen.scaled,
    totalPagesMismatch,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function formatPlan(
  opts: Options,
  sources: Source[],
  books: BookAgg[],
  assignments: Assignment[],
  koinsightBooks: Map<string, { title: string; referencePages: number | null }>,
  existingPairs: Set<string>,
  manualMerged: Map<string, ExistingBookDevice>
): string {
  const lines: string[] = [];
  const line = (s = '') => lines.push(s);

  line('='.repeat(96));
  line(` Retro device attribution plan${opts.apply ? ' (APPLY)' : ' (DRY RUN)'}`);
  line('='.repeat(96));
  line(`KoInsight DB : ${path.resolve(opts.dbPath)}`);
  line(`Mode        : ${opts.apply ? 'APPLY (writes!)' : 'DRY-RUN (read-only, no changes)'}`);
  line('Sources     :');
  for (const s of sources) {
    line(
      `  [${pad(s.deviceId, 16)}] ${pad(s.label, 16)} ${pad(
        `${s.rows.size} books / ${s.rowCount} rows`,
        24
      )} ${s.absPath}`
    );
  }
  line(`Scope       : ${books.length} books, ${assignments.length} manual-upload page_stat rows`);
  line('');

  // Per-book page_stat reassignment
  const devIds = sources.map((s) => s.deviceId);
  const header =
    pad('book_md5', 34) +
    pad('title', 31) +
    pad('rows', 6) +
    devIds.map((d) => pad(d, 10)).join('') +
    pad('unmatch', 8) +
    pad('ambig', 6);
  line('--- page_stat reassignment ---');
  line(header);
  line('-'.repeat(header.length));
  for (const b of books.sort((a, c) => c.total - a.total)) {
    let row = pad(b.md5, 34) + pad(b.title, 31) + pad(String(b.total), 6);
    for (const d of devIds) row += pad(String(b.perDevice.get(d) ?? 0), 10);
    row += pad(String(b.unmatched), 8) + pad(String(b.ambiguous), 6);
    line(row);
  }
  line('-'.repeat(header.length));

  const totals: Record<string, number> = {};
  let totalUnmatched = 0;
  let totalAmbig = 0;
  for (const a of assignments) {
    const k = a.deviceId ?? '(unmatched)';
    totals[k] = (totals[k] ?? 0) + 1;
    if (!a.deviceId) totalUnmatched++;
    if (a.ambiguous) totalAmbig++;
  }
  line(
    `Totals: ${assignments.length} rows  |  ` +
      devIds.map((d) => `${d}=${totals[d] ?? 0}`).join('  ') +
      `  unmatched=${totalUnmatched}  ambiguous=${totalAmbig}`
  );
  line('');

  // book_device reconstruction
  line(`--- book_device BEFORE (single last-write-wins '${UNKNOWN_DEVICE_ID}' row) ---`);
  if (manualMerged.size === 0) {
    line('  (none)');
  } else {
    const beforeHeader =
      pad('book_md5', 34) +
      pad('title', 31) +
      pad('pages', 8) +
      pad('read_pg', 9) +
      pad('read_time', 11);
    line(beforeHeader);
    line('-'.repeat(beforeHeader.length));
    for (const [md5, mb] of manualMerged) {
      line(
        pad(md5, 34) +
          pad(koinsightBooks.get(md5)?.title ?? '', 31) +
          pad(String(mb.pages), 8) +
          pad(String(mb.total_read_pages), 9) +
          pad(String(mb.total_read_time), 11)
      );
    }
  }
  line('');

  line('--- book_device AFTER (per-device reading stats from source DBs) ---');
  const bdHeader =
    pad('book_md5', 34) +
    pad('title', 31) +
    pad('device', 16) +
    pad('pages', 8) +
    pad('read_pg', 9) +
    pad('read_time', 11) +
    pad('last_open', 12) +
    'action';
  line(bdHeader);
  line('-'.repeat(bdHeader.length));
  for (const s of sources) {
    for (const [md5, sb] of s.books) {
      if (!koinsightBooks.has(md5)) continue;
      const action = existingPairs.has(`${md5}|${s.deviceId}`) ? 'update' : 'insert';
      line(
        pad(md5, 34) +
          pad(sb.title, 31) +
          pad(s.deviceId, 16) +
          pad(String(sb.pages), 8) +
          pad(String(sb.totalReadPages), 9) +
          pad(String(sb.totalReadTime), 11) +
          pad(String(sb.lastOpen), 12) +
          action
      );
    }
  }
  line('');

  // Actions
  line('--- actions ---');
  line(`Upsert device        : ${sources.map((s) => `${s.deviceId} ("${s.label}")`).join(', ')}`);
  const bdCount = sources.reduce(
    (n, s) => n + [...s.books.keys()].filter((m) => koinsightBooks.has(m)).length,
    0
  );
  line(`Upsert book_device   : ${bdCount} rows`);
  line(`Reassign page_stat   : ${assignments.filter((a) => a.deviceId).length} rows`);
  line(`Leave on manual-upload: ${totalUnmatched} rows`);
  const superseded = books.filter((b) => b.unmatched === 0 && b.total > 0).map((b) => b.md5);
  if (!opts.keepMergedBookDevice) {
    line(`Delete superseded '${UNKNOWN_DEVICE_ID}' book_device rows: ${superseded.length}`);
  } else {
    line(`Keep merged '${UNKNOWN_DEVICE_ID}' book_device rows (--keep-merged-book-device)`);
  }
  if (opts.setReferencePages) {
    line('book.reference_pages : fill with max(book_device.pages) where still NULL:');
    for (const md5 of superseded) {
      const kb = koinsightBooks.get(md5);
      if (!kb) continue;
      let maxPages = 0;
      for (const s of sources) {
        const sb = s.books.get(md5);
        if (sb) maxPages = Math.max(maxPages, sb.pages);
      }
      const current = kb.referencePages;
      line(
        `  ${pad(md5, 34)} ${pad(kb.title, 31)} ` +
          (current == null ? `NULL -> ${maxPages}` : `${current} (kept, already set)`)
      );
    }
  } else {
    line('book.reference_pages : left untouched (use --set-reference-pages to set)');
  }

  // Sample of problematic rows
  const unmatchedSamples = assignments.filter((a) => !a.deviceId).slice(0, 10);
  if (unmatchedSamples.length) {
    line('');
    line(`--- sample unmatched rows (first ${unmatchedSamples.length}) ---`);
    for (const a of unmatchedSamples) line(`  page_stat.id=${a.rowId} book=${a.bookMd5}`);
  }
  const ambigSamples = assignments.filter((a) => a.ambiguous).slice(0, 10);
  if (ambigSamples.length) {
    line('');
    line(`--- sample ambiguous rows (first ${ambigSamples.length}) ---`);
    for (const a of ambigSamples) line(`  page_stat.id=${a.rowId} book=${a.bookMd5}`);
  }

  return lines.join('\n');
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(usage());
    return;
  }
  if (opts.sources.length === 0) {
    process.stderr.write('error: at least one --source is required\n\n');
    process.stderr.write(usage());
    process.exitCode = 1;
    return;
  }

  const dbPath = path.resolve(
    opts.dbPath.startsWith('~') ? path.join(os.homedir(), opts.dbPath.slice(1)) : opts.dbPath
  );
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`error: KoInsight DB not found: ${dbPath}\n`);
    process.exitCode = 1;
    return;
  }

  // Guard the real production DB against accidental writes. Dry-run is
  // read-only and always allowed.
  if (opts.apply && !opts.forceProd && path.resolve(dbPath) === path.resolve(PROD_DB)) {
    process.stderr.write(
      `error: refusing to write to the production DB (${path.resolve(PROD_DB)}).\n` +
        `Re-run with --force-prod if you really mean it (a backup is made first),\n` +
        `or point --db at a different copy.\n`
    );
    process.exitCode = 1;
    return;
  }

  // Resolve device ids
  const seenIds = new Set<string>();
  const resolved = opts.sources.map(({ rawPath, label }) => {
    const deviceId = opts.idOverrides.get(label) ?? slugify(label);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(deviceId)) {
      throw new Error(`Device id "${deviceId}" (label "${label}") is not a valid slug`);
    }
    if (deviceId === UNKNOWN_DEVICE_ID) {
      throw new Error(`Device id must not be "${UNKNOWN_DEVICE_ID}"`);
    }
    if (seenIds.has(deviceId)) {
      throw new Error(`Duplicate device id "${deviceId}" - use --id to disambiguate`);
    }
    seenIds.add(deviceId);
    return { rawPath, label, deviceId };
  });

  const sources = resolved.map((r) => loadSource(r.rawPath, r.label, r.deviceId));
  const scopeMd5s = new Set<string>();
  for (const s of sources) for (const md5 of s.books.keys()) scopeMd5s.add(md5);

  if (scopeMd5s.size === 0) {
    process.stderr.write('error: no books found in the provided source DBs\n');
    process.exitCode = 1;
    return;
  }

  // Open KoInsight DB
  const ksDb = new Database(dbPath, { readonly: !opts.apply, fileMustExist: true });
  if (opts.apply) ksDb.pragma('foreign_keys = ON');

  const koinsightBooks = new Map<string, { title: string; referencePages: number | null }>();
  {
    const rows = ksDb.prepare('SELECT md5, title, reference_pages FROM book').all() as {
      md5: string;
      title: string | null;
      reference_pages: number | null;
    }[];
    for (const r of rows) {
      koinsightBooks.set(r.md5, { title: r.title ?? '', referencePages: r.reference_pages });
    }
  }

  const manualMerged = new Map<string, ExistingBookDevice>();
  const existingPairs = new Set<string>();
  {
    const rows = ksDb
      .prepare(
        `SELECT book_md5, device_id, pages, total_read_pages, total_read_time, last_open
         FROM book_device`
      )
      .all() as {
      book_md5: string;
      device_id: string;
      pages: number | null;
      total_read_pages: number | null;
      total_read_time: number | null;
      last_open: number | null;
    }[];
    for (const r of rows) {
      existingPairs.add(`${r.book_md5}|${r.device_id}`);
      if (r.device_id === UNKNOWN_DEVICE_ID) {
        manualMerged.set(r.book_md5, {
          pages: r.pages ?? 0,
          total_read_pages: r.total_read_pages ?? 0,
          total_read_time: r.total_read_time ?? 0,
          last_open: r.last_open ?? 0,
        });
      }
    }
  }

  // Pull manual-upload page_stat rows in scope
  const placeholders = [...scopeMd5s].map(() => '?').join(',');
  const ksRows = ksDb
    .prepare(
      `SELECT id, book_md5, page, start_time, duration, total_pages
       FROM page_stat
       WHERE device_id = ? AND book_md5 IN (${placeholders})`
    )
    .all(UNKNOWN_DEVICE_ID, ...scopeMd5s) as KoInsightPageStat[];

  // Match
  const assignments: Assignment[] = [];
  const bookAggs = new Map<string, BookAgg>();
  let scaledCount = 0;
  let totalPagesMismatchCount = 0;

  for (const row of ksRows) {
    const m = matchRow(row, sources);
    const a: Assignment = {
      rowId: row.id,
      bookMd5: row.book_md5,
      deviceId: m.deviceId,
      ambiguous: m.ambiguous,
      scaledTime: m.scaledTime,
      totalPagesMismatch: m.totalPagesMismatch,
    };
    assignments.push(a);
    if (m.scaledTime) scaledCount++;
    if (m.totalPagesMismatch) totalPagesMismatchCount++;

    let agg = bookAggs.get(row.book_md5);
    if (!agg) {
      agg = {
        md5: row.book_md5,
        title: koinsightBooks.get(row.book_md5)?.title ?? '',
        total: 0,
        perDevice: new Map(),
        unmatched: 0,
        ambiguous: 0,
      };
      bookAggs.set(row.book_md5, agg);
    }
    agg.total++;
    if (a.deviceId) agg.perDevice.set(a.deviceId, (agg.perDevice.get(a.deviceId) ?? 0) + 1);
    else agg.unmatched++;
    if (a.ambiguous) agg.ambiguous++;
  }

  const report = formatPlan(
    opts,
    sources,
    [...bookAggs.values()],
    assignments,
    koinsightBooks,
    existingPairs,
    manualMerged
  );

  if (!opts.apply) {
    process.stdout.write(report + '\n');
    if (scaledCount) {
      process.stdout.write(
        `\nnote: ${scaledCount} row(s) matched using a /1000 start_time fallback\n`
      );
    }
    if (totalPagesMismatchCount) {
      process.stdout.write(
        `note: ${totalPagesMismatchCount} row(s) matched on page+time but total_pages differed\n`
      );
    }
    process.stdout.write('\nDRY-RUN complete. Re-run with --apply to write changes.\n');
    return;
  }

  // ---- APPLY ----
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.bak-${stamp}`;
  fs.copyFileSync(dbPath, backupPath);

  const plan = {
    deviceUpsert: ksDb.prepare(
      `INSERT INTO device (id, model) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET model = excluded.model`
    ),
    bookDeviceUpsert: ksDb.prepare(
      `INSERT INTO book_device
         (book_md5, device_id, last_open, notes, highlights, pages, total_read_time, total_read_pages)
       VALUES (@book_md5, @device_id, @last_open, @notes, @highlights, @pages, @total_read_time, @total_read_pages)
       ON CONFLICT(book_md5, device_id) DO UPDATE SET
         last_open = excluded.last_open,
         notes = excluded.notes,
         highlights = excluded.highlights,
         pages = excluded.pages,
         total_read_time = excluded.total_read_time,
         total_read_pages = excluded.total_read_pages`
    ),
    reassign: ksDb.prepare(`UPDATE page_stat SET device_id = ? WHERE id = ?`),
    deleteMergedBookDevice: ksDb.prepare(
      `DELETE FROM book_device WHERE book_md5 = ? AND device_id = ?`
    ),
    setReferencePages: ksDb.prepare(
      `UPDATE book SET reference_pages = ? WHERE md5 = ? AND reference_pages IS NULL`
    ),
  };

  const run = ksDb.transaction(() => {
    // 1. devices + 2. book_device
    for (const s of sources) {
      plan.deviceUpsert.run(s.deviceId, s.label);
      for (const [md5, sb] of s.books) {
        if (!koinsightBooks.has(md5)) continue;
        plan.bookDeviceUpsert.run({
          book_md5: md5,
          device_id: s.deviceId,
          last_open: sb.lastOpen,
          notes: sb.notes,
          highlights: sb.highlights,
          pages: sb.pages,
          total_read_time: sb.totalReadTime,
          total_read_pages: sb.totalReadPages,
        });
      }
    }

    // 3. page_stat reassignment
    for (const a of assignments) {
      if (a.deviceId) plan.reassign.run(a.deviceId, a.rowId);
    }

    // 4. remove superseded manual-upload book_device rows
    if (!opts.keepMergedBookDevice) {
      for (const agg of bookAggs.values()) {
        if (agg.unmatched === 0 && agg.total > 0) {
          plan.deleteMergedBookDevice.run(agg.md5, UNKNOWN_DEVICE_ID);
        }
      }
    }

    // 5. optional reference_pages
    if (opts.setReferencePages) {
      for (const agg of bookAggs.values()) {
        let maxPages = 0;
        for (const s of sources) {
          const sb = s.books.get(agg.md5);
          if (sb) maxPages = Math.max(maxPages, sb.pages);
        }
        if (maxPages > 0) plan.setReferencePages.run(maxPages, agg.md5);
      }
    }
  });

  run();

  process.stdout.write(report + '\n\n');
  process.stdout.write(`Backup written to: ${backupPath}\n`);
  if (scaledCount) process.stdout.write(`note: ${scaledCount} row(s) matched via /1000 fallback\n`);
  if (totalPagesMismatchCount) {
    process.stdout.write(
      `note: ${totalPagesMismatchCount} row(s) matched with total_pages mismatch\n`
    );
  }

  // Post-apply verification summary
  const after = ksDb
    .prepare(
      `SELECT device_id, COUNT(*) AS n FROM page_stat
       WHERE book_md5 IN (${placeholders}) GROUP BY device_id ORDER BY device_id`
    )
    .all(...scopeMd5s) as { device_id: string | null; n: number }[];
  process.stdout.write('\npage_stat rows per device after apply:\n');
  for (const r of after) process.stdout.write(`  ${r.device_id ?? '(null)'}: ${r.n}\n`);

  ksDb.close();
  for (const s of sources) s.db.close();
}

try {
  main();
} catch (err) {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exitCode = 1;
}
