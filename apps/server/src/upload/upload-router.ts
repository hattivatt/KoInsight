import { Router } from 'express';
import { unlinkSync } from 'fs';
import multer from 'multer';
import { appConfig } from '../config';
import { resolveUploadDevice } from './device-resolution';
import { UploadService } from './upload-service';

const storage = multer.diskStorage({
  destination: (_req, _res, cb) => {
    cb(null, appConfig.dataPath);
  },
  filename: (_req, _res, cb) => {
    cb(null, appConfig.upload.filename);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/octet-stream' || file.originalname.endsWith('.sqlite3')) {
      cb(null, true); // Accept the file
    } else {
      cb(new Error('Only .sqlite3 files are allowed'));
    }
  },
  limits: { fileSize: appConfig.upload.maxFileSizeMegaBytes * 1024 * 1024 },
});

const router = Router();

router.post('/', upload.single('file'), async (req, res, next) => {
  const uploadedFilePath = req.file?.path;

  if (!uploadedFilePath) {
    res.status(400).json({ error: 'No file uploaded' });
    next();
    return;
  }

  // Resolve the device that produced this statistics DB. The device id is read
  // from the `deviceId` form field, else derived from the `deviceName` field,
  // else taken from the `X-Device-Id` header, else falls back (with a warning)
  // to the legacy `manual-upload` pseudo-device.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const device = resolveUploadDevice({
    deviceId: body.deviceId ?? body.device_id,
    deviceName: body.deviceName ?? body.device_name,
    headerDeviceId: req.header('X-Device-Id'),
  });

  if (device.source === 'legacy') {
    console.warn(
      '[upload] No deviceId/deviceName field and no X-Device-Id header; ' +
        'attributing this upload to the legacy "manual-upload" device.'
    );
  } else {
    console.info(
      `[upload] Importing statistics for device "${device.id}" (${device.source}` +
        (device.source === 'deviceName' ? `: "${device.label}"` : '') +
        ')'
    );
  }

  let db;
  try {
    db = UploadService.openStatisticsDbFile(uploadedFilePath);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Invalid SQLite file or no books found' });
    return;
  }

  try {
    const { newBooks, newPageStats } = UploadService.extractDataFromStatisticsDb(db, device.id);
    await UploadService.uploadStatisticData(
      newBooks,
      newPageStats,
      undefined,
      device.id,
      device.label
    );

    res.status(200).json({ message: 'Database imported successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to import database' });
  } finally {
    db.close();
    unlinkSync(uploadedFilePath);
  }
});

router.use((err: any, req: any, res: any, next: any) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    const maxMb = Math.round(appConfig.upload.maxFileSizeMegaBytes);
    return res
      .status(413)
      .json({ error: `File too large. Maximum file size allowed is ${maxMb} MB.` });
  }
  return next(err);
});

export { router as uploadRouter };
