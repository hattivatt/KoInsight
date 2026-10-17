/**
 * CANONICAL machine-readable description of the KoInsight HTTP API.
 *
 * This is the single source of truth served by `GET /api/schema`
 * (see `./api-docs-router.ts`) and printed by the server's `--print-api` flag
 * (see `../app.ts`). Keep it hand-maintained and in sync with the routers — it
 * is intentionally a pure data module (no express/db imports) so it can be
 * printed without booting the server or touching the database.
 *
 * Shapes referenced below live in `@koinsight/common/types`.
 */
import type { ApiDescription } from '@koinsight/common/types/api-description';

/**
 * Read the release version from the monorepo root `package.json`.
 *
 * Resolved relative to the compiled file: in the dev tree that is
 * `apps/server/src/api-docs/` and in `dist`/the Nix layout it is
 * `apps/server/dist/api-docs/` — in both cases four levels up is the repo root,
 * which is the one `package.json` the Nix install copies. Falls back to
 * `'unknown'` if the file cannot be resolved (e.g. a relocated bundle).
 */
function resolveVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../../../package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Shared description for the Open Library cover-proxy group. */
const OPEN_LIBRARY_NOTE =
  'Proxies the public Open Library API (openlibrary.org). Requires outbound network access.';

export const apiDescription: ApiDescription = {
  server: 'KoInsight',
  version: resolveVersion(),
  description:
    'Self-hosted KOReader reading-statistics server. Serves the KoInsight dashboard, a KOReader sync plugin API and a KoSync-compatible progress-sync API.',
  authOverview:
    'KoInsight is a single-user, self-hosted server. By design every HTTP endpoint is unauthenticated EXCEPT the KoSync progress write/read endpoints (PUT /syncs/progress, GET /syncs/progress/:document), which require KOReader KoSync auth headers (x-auth-user / x-auth-key). It is expected to run on a trusted network or behind a reverse proxy / basic auth that adds access control. In particular the full progress list (GET /syncs/progress) is unauthenticated.',
  groups: [
    {
      name: 'kosync',
      description:
        'KOReader KoSync-compatible progress sync API. Mounted at the server root (not under /api) so KOReader can talk to it directly.',
      endpoints: [
        {
          method: 'POST',
          path: '/users/create',
          summary: 'Create a KoSync user account.',
          auth: 'none',
          request: { username: 'string', password: 'string' },
          response: { message: 'User created successfully' },
          notes:
            '201 on success; 400 if username/password missing; 402 if the user already exists.',
        },
        {
          method: 'GET',
          path: '/users/auth',
          summary: 'Validate KoSync credentials.',
          auth: 'kosync (x-auth-user / x-auth-key headers)',
          request: { headers: { 'x-auth-user': 'string', 'x-auth-key': 'string' } },
          response: { authorized: 'OK' },
          notes: '200 when authorized, 401 otherwise, 400 if headers are missing.',
        },
        {
          method: 'PUT',
          path: '/syncs/progress',
          summary: 'Create or update reading progress for a document.',
          auth: 'kosync (x-auth-user / x-auth-key headers)',
          request: {
            document: 'string (book md5)',
            progress: 'string',
            percentage: 'number',
            device: 'string',
            device_id: 'string',
          },
          response: 'Partial<Progress>',
          notes: '400 if any field is missing; 401 if unauthenticated.',
        },
        {
          method: 'GET',
          path: '/syncs/progress/:document',
          summary: 'Get stored reading progress for a document (book md5).',
          auth: 'kosync (x-auth-user / x-auth-key headers)',
          response: 'Progress',
          notes: '404 if no progress exists for the user/document.',
        },
        {
          method: 'GET',
          path: '/syncs/progress',
          summary: 'List the reading progress of all users.',
          auth: 'none (reverse-proxy protected)',
          response: 'ProgressWithUsername[]',
          notes:
            "Unauthenticated by design. Exposes every user's progress — protect the deployment with a reverse proxy.",
        },
      ],
    },
    {
      name: 'plugin',
      description: 'API used by the KOReader koinsight.koplugin. Requires plugin version 0.3.0.',
      endpoints: [
        {
          method: 'POST',
          path: '/api/plugin/device',
          summary: 'Register a KOReader device.',
          auth: 'none',
          request: { version: '0.3.0', id: 'string', model: 'string' },
          response: { message: 'Device registered successfully' },
          notes: '400 if version !== 0.3.0 or id/model missing.',
        },
        {
          method: 'POST',
          path: '/api/plugin/import',
          summary: 'Import books, page stats and (optionally) annotations from the plugin.',
          auth: 'none',
          request: {
            version: '0.3.0',
            books: 'KoReaderBook[]',
            stats: 'PageStat[]',
            annotations: 'Record<string, KoReaderAnnotation[]> (optional)',
            device_id: 'string (optional, required for annotation sync)',
          },
          response: { message: 'Upload successful' },
          notes: '400 if version !== 0.3.0.',
        },
        {
          method: 'GET',
          path: '/api/plugin/health',
          summary: 'Plugin health/version check.',
          auth: 'none',
          request: { version: '0.3.0' },
          response: { message: 'Plugin is healthy' },
          notes:
            'The version gate reads the request body, so callers must still send `{ "version": "0.3.0" }` with this GET.',
        },
        {
          method: 'GET',
          path: '/api/plugin/download',
          summary: 'Download the KOReader plugin bundle as a zip.',
          auth: 'none',
          response: 'application/zip (koinsight.plugin.zip)',
        },
      ],
    },
    {
      name: 'books',
      description: 'Book catalogue, metadata, genres and covers.',
      endpoints: [
        {
          method: 'GET',
          path: '/api/books',
          summary: 'List all books with aggregated data.',
          auth: 'none',
          request: {
            query: { showHidden: 'boolean (optional, true to include soft-deleted books)' },
          },
          response: 'BookWithData[]',
        },
        {
          method: 'GET',
          path: '/api/books/:bookId',
          summary: 'Get a single book with aggregated data.',
          auth: 'none',
          request: { query: { includeDeleted: 'boolean (optional)' } },
          response: 'BookWithData',
          notes: '404 if the book does not exist.',
        },
        {
          method: 'DELETE',
          path: '/api/books/:bookId',
          summary: 'Delete a book.',
          auth: 'none',
          response: { message: 'Book deleted' },
        },
        {
          method: 'PUT',
          path: '/api/books/:bookId/hide',
          summary: 'Soft-delete (hide) or restore a book.',
          auth: 'none',
          request: { hidden: 'boolean' },
          response: { message: 'Book hidden' },
        },
        {
          method: 'PUT',
          path: '/api/books/:bookId/reference_pages',
          summary: 'Set the canonical page count used to normalise cross-device stats.',
          auth: 'none',
          request: { reference_pages: 'number' },
          response: { message: 'Reference pages updated' },
        },
        {
          method: 'POST',
          path: '/api/books/:bookId/genres',
          summary: 'Add a genre to a book.',
          auth: 'none',
          request: { genreName: 'string' },
          response: { message: 'Genre added' },
        },
        {
          method: 'GET',
          path: '/api/books/:bookId/cover',
          summary: 'Fetch the stored cover image for a book.',
          auth: 'none',
          response: 'image/* (binary)',
          notes: '404 if the book has no cover.',
        },
        {
          method: 'POST',
          path: '/api/books/:bookId/cover',
          summary: 'Upload/replace the cover image for a book.',
          auth: 'none',
          multipart: 'file: .png/.jpg/.jpeg/.gif (max 10 MB)',
          response: { message: 'Cover updated' },
          notes: '400 if no file is provided.',
        },
      ],
    },
    {
      name: 'stats',
      description: 'Reading statistics.',
      endpoints: [
        {
          method: 'GET',
          path: '/api/stats',
          summary: 'Get aggregated reading statistics.',
          auth: 'none',
          response: 'GetAllStatsResponse',
        },
        {
          method: 'GET',
          path: '/api/stats/:book_md5',
          summary: 'Get all page-stat rows for a book.',
          auth: 'none',
          response: 'PageStat[]',
        },
      ],
    },
    {
      name: 'devices',
      description: 'Known KOReader devices.',
      endpoints: [
        {
          method: 'GET',
          path: '/api/devices',
          summary: 'List all devices.',
          auth: 'none',
          response: 'Device[]',
        },
      ],
    },
    {
      name: 'upload',
      description: 'Manual upload of a KOReader statistics.sqlite3 database.',
      endpoints: [
        {
          method: 'POST',
          path: '/api/upload',
          summary: 'Upload and import a KOReader statistics.sqlite3 database.',
          auth: 'none',
          multipart: 'file: .sqlite3 (max MAX_FILE_SIZE_MB, default 100 MB)',
          request: {
            fields: {
              deviceId: 'string (optional, used verbatim)',
              deviceName: 'string (optional, slugified into a device id)',
            },
            headers: { 'X-Device-Id': 'string (optional fallback)' },
          },
          response: { message: 'Database imported successfully' },
          notes:
            'Device precedence: deviceId > deviceName > X-Device-Id > legacy "manual-upload". 413 if the file exceeds the limit; 400 for a non-sqlite file.',
        },
      ],
    },
    {
      name: 'open-library',
      description: `Open Library cover proxy. ${OPEN_LIBRARY_NOTE}`,
      endpoints: [
        {
          method: 'GET',
          path: '/api/open-library/list-covers',
          summary: 'Search Open Library for cover ids matching a term.',
          auth: 'none',
          request: {
            query: { searchTerm: 'string', limit: 'number (optional, default 3)' },
          },
          response: 'number[] (Open Library cover ids)',
        },
        {
          method: 'GET',
          path: '/api/open-library/cover',
          summary: 'Download an Open Library cover and store it for a book.',
          auth: 'none',
          request: {
            query: {
              coverId: 'string',
              bookId: 'number',
              size: "'S' | 'M' | 'L' (optional, default 'M')",
            },
          },
          response: { status: 'Cover updated' },
          notes: '404 if the book or cover is not found.',
        },
      ],
    },
    {
      name: 'ai',
      description: 'AI-generated book insights (requires an OpenAI API key).',
      endpoints: [
        {
          method: 'GET',
          path: '/api/ai/book-insights',
          summary: 'Generate genre/summary/cover suggestions for a book title/author.',
          auth: 'none (server needs OPENAI_API_KEY)',
          request: { query: { title: 'string', author: 'string' } },
          response: 'BookDetails { genres, summary, cover }',
          notes: '500 if OPENAI_API_KEY is not configured or the request fails.',
        },
      ],
    },
    {
      name: 'meta',
      description: 'API self-description.',
      endpoints: [
        {
          method: 'GET',
          path: '/api/schema',
          summary: 'Return this machine-readable API description as JSON.',
          auth: 'none',
          response: 'ApiDescription',
        },
      ],
    },
  ],
  types: [
    {
      name: 'BookWithData',
      description: 'Book row plus aggregated stats and related entities (returned by /api/books).',
      fields: [
        { name: 'id', type: 'number' },
        { name: 'md5', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'authors', type: 'string' },
        { name: 'series', type: 'string' },
        { name: 'language', type: 'string' },
        { name: 'soft_deleted', type: 'boolean' },
        { name: 'reference_pages', type: 'number | null' },
        { name: 'last_open', type: 'number' },
        { name: 'total_read_time', type: 'number' },
        { name: 'total_pages', type: 'number' },
        {
          name: 'total_read_pages',
          type: 'number',
          description: 'Reading-event count (page_stat rows), NOT a page count (legacy field).',
        },
        {
          name: 'unique_read_pages',
          type: 'number',
          description: 'Unique pages read (canonical scale).',
        },
        {
          name: 'read_progress_pages',
          type: 'number',
          description: 'Furthest position reached, on the canonical page scale.',
        },
        { name: 'notes', type: 'number' },
        { name: 'highlights', type: 'number' },
        { name: 'read_per_day', type: 'Record<string, number>' },
        { name: 'started_reading', type: 'number' },
        { name: 'highlights_count', type: 'number' },
        { name: 'notes_count', type: 'number' },
        { name: 'bookmarks_count', type: 'number' },
        { name: 'deleted_count', type: 'number' },
        { name: 'stats', type: 'PageStat[]' },
        { name: 'device_data', type: 'BookDevice[]' },
        { name: 'genres', type: 'Genre[]' },
        { name: 'annotations', type: 'Annotation[]' },
      ],
    },
    {
      name: 'PageStat',
      description: 'One reading session (a row of page_stat).',
      fields: [
        { name: 'page', type: 'number' },
        { name: 'start_time', type: 'number', description: 'Unix seconds (ms in API responses).' },
        { name: 'duration', type: 'number', description: 'Seconds read.' },
        { name: 'total_pages', type: 'number' },
        { name: 'device_id', type: 'string' },
        { name: 'book_md5', type: 'string' },
      ],
    },
    {
      name: 'KoReaderBook',
      description: 'Book shape accepted by POST /api/plugin/import.',
      fields: [
        { name: 'id', type: 'number' },
        { name: 'md5', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'authors', type: 'string' },
        { name: 'notes', type: 'number' },
        { name: 'last_open', type: 'number' },
        { name: 'highlights', type: 'number' },
        { name: 'pages', type: 'number' },
        { name: 'series', type: 'string' },
        { name: 'language', type: 'string' },
        { name: 'total_read_time', type: 'number (optional)' },
        { name: 'total_read_pages', type: 'number (optional)' },
      ],
    },
    {
      name: 'KoReaderAnnotation',
      description:
        'Annotation shape accepted inside the `annotations` map of POST /api/plugin/import.',
      fields: [
        { name: 'datetime', type: 'string' },
        { name: 'datetime_updated', type: 'string (optional)' },
        { name: 'drawer', type: 'string (optional)' },
        { name: 'color', type: 'string (optional)' },
        { name: 'text', type: 'string (optional)' },
        { name: 'note', type: 'string (optional)' },
        { name: 'chapter', type: 'string (optional)' },
        { name: 'pageno', type: 'number (optional)' },
        {
          name: 'page',
          type: 'number | string',
          description: 'PDF: number, EPUB: xPointer string.',
        },
        { name: 'total_pages', type: 'number (optional)' },
        { name: 'pos0', type: 'AnnotationPosition (optional)' },
        { name: 'pos1', type: 'AnnotationPosition (optional)' },
      ],
    },
    {
      name: 'Progress',
      description: 'Stored KoSync reading progress.',
      fields: [
        { name: 'id', type: 'number' },
        { name: 'user_id', type: 'number' },
        { name: 'document', type: 'string' },
        { name: 'progress', type: 'string' },
        { name: 'percentage', type: 'number' },
        { name: 'device', type: 'string' },
        { name: 'device_id', type: 'string' },
        { name: 'created_at', type: 'string' },
        { name: 'updated_at', type: 'string' },
      ],
    },
    {
      name: 'Device',
      fields: [
        { name: 'id', type: 'string' },
        { name: 'model', type: 'string' },
      ],
    },
    {
      name: 'GetAllStatsResponse',
      description: 'Response of GET /api/stats.',
      fields: [
        { name: 'stats', type: 'PageStat[]' },
        { name: 'perMonth', type: 'PerMonthReadingTime[]' },
        { name: 'perDayOfTheWeek', type: 'PerDayOfTheWeek[]' },
        { name: 'mostPagesInADay', type: 'number' },
        { name: 'totalReadingTime', type: 'number' },
        { name: 'longestDay', type: 'number' },
        { name: 'last7DaysReadTime', type: 'number' },
        { name: 'totalPagesRead', type: 'number' },
      ],
    },
  ],
  notes: [
    'All timestamps are Unix epoch values; `start_time` is stored in seconds but returned in milliseconds by the API.',
    'GET /api/schema and the `--print-api` server flag expose this same description.',
    'The SPA fallback (serving index.html) is registered after all API routers, so /api/* paths are never swallowed by it.',
    'Plugin API requires exactly version 0.3.0; older plugins receive 400 with an upgrade message.',
  ],
};
