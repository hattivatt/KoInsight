/**
 * Machine-readable description of the KoInsight HTTP API.
 *
 * Types only — the hand-maintained data lives in the server
 * (`apps/server/src/api-docs/api-description.ts`) and is served verbatim by
 * `GET /api/schema` and the `--print-api` CLI flag. Keeping the shape here lets
 * the web app (and any other consumer) type the payload without importing the
 * server.
 */

/** Any JSON-serializable value (used for request/response examples). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ApiEndpoint = {
  /** HTTP method, upper-case: GET, POST, PUT or DELETE. */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path relative to the server root, with `:params` marked. */
  path: string;
  /** One-line description of what the endpoint does. */
  summary: string;
  /** Free-form auth description (`none`, `kosync`, `none (reverse-proxy protected)`, …). */
  auth: string;
  /** Example/shape of the request body or query parameters. */
  request?: JsonValue;
  /** Example/shape of the response body (usually a type name + example). */
  response?: JsonValue;
  /** `multipart/form-data` field(s), when the endpoint accepts a file upload. */
  multipart?: string;
  /** Anything a caller must know that does not fit the fields above. */
  notes?: string;
};

export type ApiGroup = {
  /** Group name, matching the router/module (e.g. `kosync`, `books`). */
  name: string;
  /** Optional human description of the group. */
  description?: string;
  endpoints: ApiEndpoint[];
};

export type ApiTypeField = {
  name: string;
  /** TypeScript-ish type string, e.g. `number`, `string`, `PageStat[]`. */
  type: string;
  description?: string;
};

/** A named type from `@koinsight/common/types`, summarized as `field: type` rows. */
export type ApiTypeDefinition = {
  name: string;
  description?: string;
  fields: ApiTypeField[];
};

export type ApiDescription = {
  /** Server/product name. */
  server: string;
  /** Release version (read from the monorepo root `package.json`). */
  version: string;
  /** Short description of the API. */
  description: string;
  /** How authentication works across the whole API. */
  authOverview: string;
  groups: ApiGroup[];
  /** Compact field lists for the most important response/request types. */
  types?: ApiTypeDefinition[];
  /** Cross-cutting notes (single-user design, reverse proxy, etc.). */
  notes: string[];
};
