# Changelog

## [Unreleased]

### New Features

Machine-readable API documentation: `GET /api/schema` returns a full JSON description of the HTTP API (every group — kosync, plugin, books/covers, stats, devices, upload, open-library, ai — with auth overview, request/response shapes and a compact type reference). The `--print-api` server flag prints the same JSON and exits, without booting the server or touching the database.

## [0.2.4] - 2026-10-17

### New Features

Bulk Annotation Sync: The "Synchronize data" button now syncs all annotations from all books in your reading history at once (previously only the currently open book). Sync on suspend still syncs statistics and annotations for the currently open book only (keeping suspend snappy).

Manual uploads are now attributed to real devices: `/api/upload` accepts `deviceId`/`deviceName` multipart fields (plus an `X-Device-Id` header), and books auto-fill `reference_pages` at ingest when it is unset.

New maintenance script `npm --workspace=server run retro-devices` retro-assigns already-merged manual-upload data from the original KOReader statistics DBs. Dry-run by default (`--apply` writes, after taking a backup).

### Bug Fixes

Cross-device pagination: all page/progress metrics are now computed on a single canonical page scale (`reference_pages ?? max(device pages)`, falling back to the widest `total_pages` on the rows), scaling every `page_stat` row by its own `total_pages` before the page intervals are unioned. Previously raw page numbers from devices with different layouts were compared directly, which under- or over-counted pages read.

Fixed Book Duplicates: Some users saw the same book twice in KoInsight, one with statistics, one with annotations. We now match books using their unique MD5 checksum instead of title.

If you have duplicates, either:

1. Delete your database and re-sync (recommended - clean start)
2. Manually delete duplicate books in the web interface (the faulty one)

New syncs won't create duplicates. If you still see duplicates, you most likely have duplicates in your KoReader statistics database and KoInsight makes those visible.

### Breaking Changes

Plugin version 0.3.0 required. Update it before syncing.

API page fields changed: `read_progress_pages` is new; `total_read_pages` now reports the reading-event count (`page_stat` row count) and `unique_read_pages` is the number of unique pages read on the canonical scale (see the cross-device pagination fix above).

---

## [0.2.2] - 2026-01-11

### Added

- Annotation sync support for currently open book
- Mark deleted annotations in the database

### Fixed

- Annotations now properly marked as deleted when removed in KoReader
- Docker build issues

## [0.2.0] - 2026-01-11

### Added

- Plugin versioning system
- Server validates plugin version before accepting data

### Changed

- **BREAKING:** Server now requires specific plugin version

---

## Earlier Versions

See git history for changes prior to v0.2.0.

[0.2.4]: https://github.com/hattivatt/KoInsight/compare/v0.2.2...v0.2.4
[0.2.2]: https://github.com/hattivatt/KoInsight/compare/v0.2.0...v0.2.2
[0.2.0]: https://github.com/GeorgeSG/koinsight/releases/tag/v0.2.0
