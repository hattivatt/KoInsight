import type { ApiDescription, ApiEndpoint } from '@koinsight/common/types/api-description';
import { execFileSync } from 'child_process';
import express from 'express';
import path from 'path';
import request from 'supertest';
import { apiDescription } from './api-description';
import { apiDocsRouter } from './api-docs-router';

const app = express();
app.use('/api/schema', apiDocsRouter);

const allEndpoints = (description: ApiDescription): ApiEndpoint[] =>
  description.groups.flatMap((group) => group.endpoints);

const findEndpoint = (method: string, endpointPath: string): ApiEndpoint | undefined =>
  allEndpoints(apiDescription).find((e) => e.method === method && e.path === endpointPath);

describe('GET /api/schema', () => {
  it('returns 200 with a JSON body', async () => {
    const response = await request(app).get('/api/schema');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body.server).toBe('KoInsight');
  });

  it('serves the same description as the canonical data module', async () => {
    const response = await request(app).get('/api/schema');
    expect(response.body).toEqual(JSON.parse(JSON.stringify(apiDescription)));
  });

  it('exposes at least nine API groups', () => {
    expect(apiDescription.groups.length).toBeGreaterThanOrEqual(9);
  });

  it('documents the key endpoints', () => {
    expect(findEndpoint('PUT', '/syncs/progress')).toBeDefined();
    expect(findEndpoint('GET', '/syncs/progress/:document')).toBeDefined();
    expect(findEndpoint('POST', '/api/upload')).toBeDefined();
    expect(findEndpoint('POST', '/api/plugin/import')).toBeDefined();
    expect(findEndpoint('POST', '/api/plugin/device')).toBeDefined();
    expect(findEndpoint('GET', '/api/books/:bookId/cover')).toBeDefined();
    expect(findEndpoint('GET', '/api/schema')).toBeDefined();
  });

  it('marks the unauthored progress list factually', () => {
    const endpoint = findEndpoint('GET', '/syncs/progress');
    expect(endpoint?.auth).toContain('none');
  });

  it('carries version, auth overview and notes', () => {
    expect(apiDescription.version).not.toBe('');
    expect(apiDescription.authOverview.length).toBeGreaterThan(0);
    expect(apiDescription.notes.length).toBeGreaterThan(0);
  });

  it('includes a compact types section', () => {
    const typeNames = (apiDescription.types ?? []).map((t) => t.name);
    expect(typeNames).toContain('BookWithData');
    expect(typeNames).toContain('PageStat');
    expect(typeNames).toContain('KoReaderBook');
  });
});

describe('--print-api CLI flag', () => {
  it('prints the API description as JSON and exits 0 without booting the server', () => {
    const out = execFileSync(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        path.join(__dirname, '..', 'app.ts'),
        '--print-api',
      ],
      {
        cwd: path.join(__dirname, '..', '..'),
        encoding: 'utf8',
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true', DOTENV_CONFIG_QUIET: 'true' },
      }
    );

    // dotenv may emit a banner before the JSON; parse from the first brace.
    const parsed = JSON.parse(out.slice(out.indexOf('{'))) as ApiDescription;
    expect(parsed.server).toBe('KoInsight');
    expect(parsed.groups.length).toBeGreaterThanOrEqual(9);
    expect(findEndpoint('POST', '/api/plugin/import')).toBeDefined();
  }, 60_000);
});
