/**
 * Device resolution for the manual `POST /api/upload` path.
 *
 * Historically that endpoint hard-coded `device_id = 'manual-upload'`, so
 * uploading statistics DBs from several devices merged every row onto one
 * pseudo-device. This module derives a *stable* device id from the fields the
 * caller can provide, or reuses an explicit id.
 *
 * The label→id derivation is intentionally IDENTICAL to the one in
 * `scripts/retro-assign-devices.ts` (Cyrillic transliteration + slugify), so
 * that data uploaded with `deviceName=Ноутбук` lands on the same device id
 * (`noutbuk`) that the retro script reconstructs, and repeated uploads of the
 * same device name are idempotent (same name ⇒ same id).
 *
 * NOTE: the transliteration table is duplicated in
 * `scripts/retro-assign-devices.ts` on purpose — that script is a standalone
 * one-off and must not import from `src/`.
 */

/** Legacy pseudo-device id kept for backwards compatibility. */
export const LEGACY_DEVICE_ID = 'manual-upload';

/** How the device id was chosen, for logging/tests. */
export type UploadDeviceSource = 'deviceId' | 'deviceName' | 'header' | 'legacy';

export type ResolvedUploadDevice = {
  id: string;
  /** Human label, only used when the device row has to be created. */
  label: string;
  source: UploadDeviceSource;
};

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

/**
 * Transliterate Cyrillic to Latin and slugify into a device id.
 * `Ноутбук` → `noutbuk`, `Телефон` → `telefon`, `Kobo Libra 2` → `kobo-libra-2`.
 * Falls back to `device` when nothing usable remains.
 */
export function slugifyDeviceId(label: string): string {
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

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

/**
 * Resolve the device for an upload.
 *
 * Precedence:
 *   1. `deviceId`   — an existing device id, used verbatim.
 *   2. `deviceName` — a human label; the id is derived deterministically from it.
 *   3. `headerDeviceId` (X-Device-Id) — used verbatim.
 *   4. legacy `manual-upload` constant, only for backwards compatibility.
 */
export function resolveUploadDevice(input: {
  deviceId?: unknown;
  deviceName?: unknown;
  headerDeviceId?: unknown;
}): ResolvedUploadDevice {
  const deviceId = firstNonEmptyString(input.deviceId);
  if (deviceId) {
    return { id: deviceId, label: deviceId, source: 'deviceId' };
  }

  const deviceName = firstNonEmptyString(input.deviceName);
  if (deviceName) {
    return { id: slugifyDeviceId(deviceName), label: deviceName, source: 'deviceName' };
  }

  const headerDeviceId = firstNonEmptyString(input.headerDeviceId);
  if (headerDeviceId) {
    return { id: headerDeviceId, label: headerDeviceId, source: 'header' };
  }

  return { id: LEGACY_DEVICE_ID, label: 'Manual Upload', source: 'legacy' };
}
