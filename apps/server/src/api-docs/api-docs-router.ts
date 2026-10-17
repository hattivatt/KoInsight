import { Request, Response, Router } from 'express';
import { apiDescription } from './api-description';

const router = Router();

/**
 * GET /api/schema
 *
 * Returns the machine-readable API self-description. The canonical data lives
 * in `./api-description.ts`; this router only serializes it.
 */
router.get('/', (_req: Request, res: Response) => {
  res.status(200).json(apiDescription);
});

export { router as apiDocsRouter };
