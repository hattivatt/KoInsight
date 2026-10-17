import { PageStat } from '@koinsight/common/types';
import { LEGACY_DEVICE_ID, resolveUploadDevice, slugifyDeviceId } from './device-resolution';
import { UploadService } from './upload-service';

describe('slugifyDeviceId', () => {
  it('transliterates Cyrillic labels (id-compatible with the retro script)', () => {
    expect(slugifyDeviceId('Ноутбук')).toEqual('noutbuk');
    expect(slugifyDeviceId('Телефон')).toEqual('telefon');
  });

  it('slugifies latin labels and keeps digits', () => {
    expect(slugifyDeviceId('Kobo Libra 2')).toEqual('kobo-libra-2');
    expect(slugifyDeviceId('  Kindle Paperwhite!! ')).toEqual('kindle-paperwhite');
  });

  it('is idempotent (same name ⇒ same id)', () => {
    expect(slugifyDeviceId('Телефон')).toEqual(slugifyDeviceId('Телефон'));
  });

  it('falls back to "device" for unusable labels', () => {
    expect(slugifyDeviceId('!!!')).toEqual('device');
  });
});

describe('resolveUploadDevice', () => {
  it('prefers an explicit deviceId', () => {
    expect(
      resolveUploadDevice({
        deviceId: 'my-device',
        deviceName: 'Ноутбук',
        headerDeviceId: 'header-device',
      })
    ).toEqual({ id: 'my-device', label: 'my-device', source: 'deviceId' });
  });

  it('derives the id from deviceName when no deviceId is given', () => {
    expect(resolveUploadDevice({ deviceName: 'Ноутбук', headerDeviceId: 'header-device' })).toEqual(
      { id: 'noutbuk', label: 'Ноутбук', source: 'deviceName' }
    );
  });

  it('uses the header when neither field is present', () => {
    expect(resolveUploadDevice({ headerDeviceId: 'header-device' })).toEqual({
      id: 'header-device',
      label: 'header-device',
      source: 'header',
    });
  });

  it('falls back to the legacy pseudo-device', () => {
    expect(resolveUploadDevice({})).toEqual({
      id: LEGACY_DEVICE_ID,
      label: 'Manual Upload',
      source: 'legacy',
    });
  });

  it('ignores blank/whitespace values', () => {
    expect(resolveUploadDevice({ deviceId: '  ', deviceName: '  ' })).toEqual({
      id: LEGACY_DEVICE_ID,
      label: 'Manual Upload',
      source: 'legacy',
    });
  });
});

describe('UploadService.resolveDeviceId', () => {
  const stat = (deviceId: string): PageStat => ({
    book_md5: 'md5',
    device_id: deviceId,
    page: 1,
    start_time: 1,
    duration: 1,
    total_pages: 100,
  });

  it('prefers the explicit override over the row device id', () => {
    expect(UploadService.resolveDeviceId([stat('from-stats')], 'override')).toEqual('override');
  });

  it('falls back to the device id carried by the rows', () => {
    expect(UploadService.resolveDeviceId([stat('from-stats')])).toEqual('from-stats');
  });

  it('falls back to the legacy pseudo-device when nothing is provided', () => {
    expect(UploadService.resolveDeviceId([])).toEqual(LEGACY_DEVICE_ID);
    expect(UploadService.resolveDeviceId([stat('')])).toEqual(LEGACY_DEVICE_ID);
  });
});
