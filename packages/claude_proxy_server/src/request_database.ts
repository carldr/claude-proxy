import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { extractClaudeCodeRequestContext } from './claude_code_request_context.ts';

/** A `subscription` route forwards Claude Code's own token. Only rows from earlier versions of the proxy have `api_key`. */
export type RouteKind = 'subscription_account' | 'subscription' | 'api_key' | 'passthrough';
export type ClientAuthKind = 'oauth' | 'api_key' | 'none';

export interface StartedProxiedRequest {
  startedAt: string;
  httpMethod: string;
  requestPath: string;
  clientAuthKind: ClientAuthKind;
  model: string | null;
  isStreaming: boolean;
  sessionId: string | null;
  /** Null when the request carries no environment block. The database then finds the project with `previousUpstreamRequestId` or the session. */
  projectPath: string | null;
  previousUpstreamRequestId: string | null;
  requestHeadersJson: string;
  requestBody: Buffer;
  lastUserMessageText: string;
  lastUserMessageToolResultText: string;
}

export interface CompletedProxiedRequest {
  completedAt: string;
  durationMs: number;
  routeKind: RouteKind | null;
  routeName: string | null;
  statusCode: number | null;
  errorType: string | null;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreation5mInputTokens: number | null;
  cacheCreation1hInputTokens: number | null;
  cacheReadInputTokens: number | null;
  estimatedCostUsd: number | null;
  responseHeadersJson: string | null;
  responseBody: string | null;
  responseText: string;
  /** The tool calls and thinking of the response. */
  responseToolText: string;
}

export interface UpstreamAttempt {
  proxiedRequestId: number;
  attemptNumber: number;
  routeKind: RouteKind;
  routeName: string;
  upstreamUrl: string;
  statusCode: number | null;
  errorBody: string | null;
  startedAt: string;
  durationMs: number;
}

export interface ProxiedRequestFilters {
  startedFrom?: string;
  startedTo?: string;
  model?: string;
  routeName?: string;
  /** "2xx", "4xx", "5xx", "pending", or one status code such as "429". */
  status?: string;
  projectName?: string;
  sessionId?: string;
  searchText?: string;
}

export interface ProxiedRequestPage {
  beforeId?: number;
  limit: number;
}

const proxiedRequestSummaryColumns = `
  r.id, r.started_at, r.completed_at, r.duration_ms, r.http_method, r.request_path, r.client_auth_kind,
  r.route_kind, r.route_name, r.model, r.is_streaming, r.session_id, r.project_path, r.project_name,
  r.is_project_path_inherited, r.status_code,
  r.error_type, r.stop_reason, r.input_tokens, r.output_tokens, r.cache_creation_5m_input_tokens,
  r.cache_creation_1h_input_tokens, r.cache_read_input_tokens, r.estimated_cost_usd,
  (SELECT COUNT(*) FROM upstream_attempts a WHERE a.proxied_request_id = r.id) AS upstream_attempt_count,
  r.user_text_preview`;

/** A top-level value of a request body whose JSON is shorter than this stays in the layout instead of becoming a part. */
const shortestRequestBodyPartLength = 256;

/** The setting that records that the whole request bodies of an earlier database are split into parts. */
const requestBodyPartsSplitSettingName = 'request_body_parts_split';

/** The number of rows that one transaction of a migration or an expiry changes. */
const requestBodyPartsSplitBatchSize = 500;

/** The length of `user_text_preview`, which the request list and the session list show. */
const userTextPreviewLength = 300;

/**
 * One top-level field of a request body, in a request body layout: `value` holds a short value itself, `part_id`
 * names a part, and `message_part_ids` names one part for each entry of `messages`.
 */
type RequestBodyLayoutField =
  | { field_name: string; value: unknown }
  | { field_name: string; part_id: number }
  | { field_name: string; message_part_ids: number[] };

/**
 * Stores every proxied request in SQLite. Request and response bodies are compressed with zstd.
 *
 * Claude Code sends the whole conversation with each request, so the messages, the tools, the system prompt and the
 * safeguards of one request are mostly the same as those of the request before it. A JSON request body is therefore
 * stored as parts in `request_body_parts`, one row for each distinct value, found by its SHA-256. The request row
 * keeps only `request_body_layout_zstd`, the list of its fields and parts. A body that compact JSON does not rebuild
 * byte for byte, such as a body with spaces after its colons, stays whole in `request_body_zstd`.
 */
export class RequestDatabase {
  private readonly database: DatabaseSync;

  /**
   * The search text of each request that has started and not completed. The search index is contentless, so
   * completeRequest cannot read the request's text back. It writes the row again with this text and the response's.
   */
  private readonly searchTextOfOpenRequests = new Map<number, { userText: string; toolText: string }>();

  /** Names the project of a new request. `applyProjectNames` replaces this function. */
  private findProjectName: (projectPath: string) => string = (projectPath) => path.basename(projectPath);

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS proxied_requests (
        id INTEGER PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        http_method TEXT NOT NULL,
        request_path TEXT NOT NULL,
        client_auth_kind TEXT NOT NULL,
        route_kind TEXT,
        route_name TEXT,
        model TEXT,
        is_streaming INTEGER NOT NULL,
        session_id TEXT,
        project_path TEXT,
        -- 1 when the request carried no environment block and project_path comes from an earlier request.
        is_project_path_inherited INTEGER NOT NULL DEFAULT 0,
        status_code INTEGER,
        error_type TEXT,
        stop_reason TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_creation_5m_input_tokens INTEGER,
        cache_creation_1h_input_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        estimated_cost_usd REAL,
        request_headers_json_zstd BLOB,
        -- The whole body, for a body that request_body_layout_zstd cannot hold. At most one of the two is set.
        request_body_zstd BLOB,
        -- The JSON list of the fields of a JSON body, each a short value or a reference to request_body_parts.
        request_body_layout_zstd BLOB,
        response_headers_json_zstd BLOB,
        response_body_zstd BLOB,
        -- The request-id response header. Claude Code sends it back as cc_prev_req in the next request.
        upstream_request_id TEXT,
        -- The first 300 characters of the last user message, for the request list and the session list.
        user_text_preview TEXT,
        -- When expireRequestContentsStartedBefore deleted the headers, bodies and search text of the request.
        contents_expired_at TEXT
      );
      CREATE INDEX IF NOT EXISTS proxied_requests_project_path ON proxied_requests (project_path);
      CREATE INDEX IF NOT EXISTS proxied_requests_route_name ON proxied_requests (route_name);

      CREATE TABLE IF NOT EXISTS upstream_attempts (
        id INTEGER PRIMARY KEY,
        proxied_request_id INTEGER NOT NULL REFERENCES proxied_requests (id),
        attempt_number INTEGER NOT NULL,
        route_kind TEXT NOT NULL,
        route_name TEXT NOT NULL,
        upstream_url TEXT NOT NULL,
        status_code INTEGER,
        error_body TEXT,
        started_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS upstream_attempts_proxied_request_id ON upstream_attempts (proxied_request_id);

      -- One row for each distinct JSON value of the request bodies: a message, the tools, the system prompt.
      -- part_last_used_on is the UTC day of the latest request that uses the part.
      CREATE TABLE IF NOT EXISTS request_body_parts (
        id INTEGER PRIMARY KEY,
        part_sha256 BLOB NOT NULL UNIQUE,
        part_json_zstd BLOB NOT NULL,
        part_last_used_on TEXT
      );

      -- rowid is proxied_requests.id. Each request repeats the whole conversation, so the index holds only what
      -- is new in each request: user_text is the last user message; tool_text is the tool results in that
      -- message plus the tool calls and thinking of the response; response_text is the text of the response.
      -- The index is contentless: it keeps no copy of the text, and a query can read only the rowid.
      CREATE VIRTUAL TABLE IF NOT EXISTS proxied_request_search_index USING fts5 (
        user_text, tool_text, response_text, content = '', contentless_delete = 1
      );

      CREATE TABLE IF NOT EXISTS proxy_settings (
        setting_name TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL
      );
    `);
    this.addProjectPathInheritanceColumns();
    this.database.exec('CREATE INDEX IF NOT EXISTS proxied_requests_upstream_request_id ON proxied_requests (upstream_request_id)');
    for (const [columnName, columnType] of [
      ['request_body_layout_zstd', 'BLOB'],
      ['request_headers_json_zstd', 'BLOB'],
      ['response_headers_json_zstd', 'BLOB'],
      ['user_text_preview', 'TEXT'],
      ['contents_expired_at', 'TEXT'],
      ['project_name', 'TEXT'],
    ]) {
      this.addMissingColumn('proxied_requests', columnName, columnType);
    }
    this.addMissingColumn('request_body_parts', 'part_last_used_on', 'TEXT');
    this.createQueryIndexes();
    const hasSplitRequestBodies = this.splitWholeRequestBodiesIntoParts();
    const hasCompressedHeaders = this.compressPlainHeaders();
    const hasMovedSearchText = this.moveSearchTextToContentlessIndex();
    if (hasSplitRequestBodies || hasCompressedHeaders || hasMovedSearchText) {
      console.log('VACUUM gives back the space of the migrated request contents.');
      this.database.exec('VACUUM');
      // VACUUM writes the whole new file through the WAL. The checkpoint copies it into the database and empties the WAL file.
      this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
  }

  /**
   * Creates the indexes that let the queries of the web UI and of the expiry read an index instead of the table,
   * and drops the indexes that they replace. Each index names the query it serves.
   */
  private createQueryIndexes(): void {
    this.database.exec(`
      DROP INDEX IF EXISTS proxied_requests_model;
      DROP INDEX IF EXISTS proxied_requests_started_at;
      DROP INDEX IF EXISTS proxied_requests_session_id;
      -- listRequestFilterOptions groups by model with MAX(started_at), and the model filter matches model.
      CREATE INDEX IF NOT EXISTS proxied_requests_model_started_at ON proxied_requests (model, started_at);
      -- listRequestFilterOptions lists project_name, and the project filter matches it.
      CREATE INDEX IF NOT EXISTS proxied_requests_project_name ON proxied_requests (project_name);
      -- summariseProxiedRequestCosts sums estimated_cost_usd by started_at, and the date filters match started_at.
      CREATE INDEX IF NOT EXISTS proxied_requests_started_at_estimated_cost_usd ON proxied_requests (started_at, estimated_cost_usd);
      -- listSessions groups every request by session_id, and assignProjectPath finds a request of a session.
      CREATE INDEX IF NOT EXISTS proxied_requests_session_id_started_at ON proxied_requests (
        session_id, started_at, project_path, estimated_cost_usd
      );
      -- expireRequestContentsStartedBefore finds the oldest requests whose contents it has not deleted.
      CREATE INDEX IF NOT EXISTS proxied_requests_contents_not_expired_started_at ON proxied_requests (started_at)
        WHERE contents_expired_at IS NULL;
      -- expireRequestContentsStartedBefore deletes the parts that no kept request uses.
      CREATE INDEX IF NOT EXISTS request_body_parts_part_last_used_on ON request_body_parts (part_last_used_on);
    `);
  }

  /** Migrates a database made before the column existed. */
  private addMissingColumn(tableName: string, columnName: string, columnType: string): void {
    if (this.listColumnNames(tableName).includes(columnName)) return;
    this.database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }

  private listColumnNames(tableName: string): string[] {
    return (this.database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name);
  }

  /**
   * Compresses the plain `request_headers_json` and `response_headers_json` of an earlier database into their
   * `_zstd` columns, in transactions of `requestBodyPartsSplitBatchSize` rows, then drops the plain columns.
   * Returns true when it changed the database.
   */
  private compressPlainHeaders(): boolean {
    const columnNames = this.listColumnNames('proxied_requests');
    if (!columnNames.includes('request_headers_json')) return false;

    const readPlainHeaders = this.database.prepare(
      'SELECT id, request_headers_json, response_headers_json FROM proxied_requests WHERE id > ? ORDER BY id LIMIT ?',
    );
    const updateHeaders = this.database.prepare(
      'UPDATE proxied_requests SET request_headers_json_zstd = ?, response_headers_json_zstd = ? WHERE id = ?',
    );
    let lastProxiedRequestId = 0;
    for (;;) {
      const plainHeaders = readPlainHeaders.all(lastProxiedRequestId, requestBodyPartsSplitBatchSize) as Array<{
        id: number;
        request_headers_json: string | null;
        response_headers_json: string | null;
      }>;
      if (plainHeaders.length === 0) break;
      this.database.exec('BEGIN');
      try {
        for (const plainHeader of plainHeaders) {
          updateHeaders.run(compressText(plainHeader.request_headers_json), compressText(plainHeader.response_headers_json), plainHeader.id);
        }
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
      lastProxiedRequestId = plainHeaders[plainHeaders.length - 1].id;
    }
    console.log(`Compressed the headers up to request ${lastProxiedRequestId}.`);
    this.database.exec('ALTER TABLE proxied_requests DROP COLUMN request_headers_json');
    this.database.exec('ALTER TABLE proxied_requests DROP COLUMN response_headers_json');
    return true;
  }

  /**
   * Moves the search text of an earlier database from `proxied_request_search`, which keeps a copy of the text,
   * to the contentless `proxied_request_search_index`. The first 300 characters of each user text go to
   * `user_text_preview`. Returns true when it changed the database.
   */
  private moveSearchTextToContentlessIndex(): boolean {
    const earlierSearchTable = this.database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'proxied_request_search'")
      .get();
    if (!earlierSearchTable) return false;

    this.database.exec('BEGIN');
    try {
      this.database.exec(`
        UPDATE proxied_requests SET user_text_preview =
          (SELECT substr(s.user_text, 1, ${userTextPreviewLength}) FROM proxied_request_search s WHERE s.rowid = proxied_requests.id);
        INSERT INTO proxied_request_search_index (rowid, user_text, tool_text, response_text)
          SELECT rowid, user_text, tool_text, response_text FROM proxied_request_search;
        DROP TABLE proxied_request_search;
      `);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    console.log('Moved the search text to the contentless search index.');
    return true;
  }

  /**
   * Splits each whole request body of an earlier database into parts, in transactions of
   * `requestBodyPartsSplitBatchSize` rows, so a stopped split continues at the next start.
   * Returns true when it changed the database.
   */
  private splitWholeRequestBodiesIntoParts(): boolean {
    if (this.readSetting(requestBodyPartsSplitSettingName) !== null) return false;

    const readWholeRequestBodies = this.database.prepare(
      `SELECT id, started_at, request_body_zstd FROM proxied_requests
       WHERE request_body_zstd IS NOT NULL AND id > ? ORDER BY id LIMIT ?`,
    );
    const updateRequestBody = this.database.prepare(
      'UPDATE proxied_requests SET request_body_zstd = NULL, request_body_layout_zstd = ? WHERE id = ?',
    );
    let lastProxiedRequestId = 0;
    let splitRequestBodyCount = 0;
    for (;;) {
      const wholeRequestBodies = readWholeRequestBodies.all(lastProxiedRequestId, requestBodyPartsSplitBatchSize) as Array<{
        id: number;
        started_at: string;
        request_body_zstd: Uint8Array;
      }>;
      if (wholeRequestBodies.length === 0) break;
      this.database.exec('BEGIN');
      try {
        for (const wholeRequestBody of wholeRequestBodies) {
          const requestBodyLayout = this.storeRequestBodyParts(
            zstdDecompressSync(wholeRequestBody.request_body_zstd),
            wholeRequestBody.started_at.slice(0, 10),
          );
          if (requestBodyLayout !== null) {
            updateRequestBody.run(requestBodyLayout, wholeRequestBody.id);
            splitRequestBodyCount += 1;
          }
        }
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
      lastProxiedRequestId = wholeRequestBodies[wholeRequestBodies.length - 1].id;
      if (splitRequestBodyCount > 0) console.log(`Split the request bodies up to request ${lastProxiedRequestId} into parts.`);
    }
    if (splitRequestBodyCount > 0) console.log(`Split ${splitRequestBodyCount} request bodies into parts.`);
    // A part that an earlier version stored has no day of use. It counts as used on the day of the split.
    this.database
      .prepare('UPDATE request_body_parts SET part_last_used_on = ? WHERE part_last_used_on IS NULL')
      .run(new Date().toISOString().slice(0, 10));
    this.writeSetting(requestBodyPartsSplitSettingName, new Date().toISOString());
    return splitRequestBodyCount > 0;
  }

  /**
   * Stores the parts of a JSON request body that are not stored already, and returns its compressed layout.
   * `usedOn` is the UTC day of the request, which becomes the day of use of each of its parts.
   * Returns null for a body that compact JSON does not rebuild byte for byte. Such a body is stored whole.
   */
  private storeRequestBodyParts(requestBody: Buffer, usedOn: string): Uint8Array | null {
    const requestBodyText = requestBody.toString('utf8');
    let parsedRequestBody: unknown;
    try {
      parsedRequestBody = JSON.parse(requestBodyText);
    } catch {
      return null;
    }
    if (typeof parsedRequestBody !== 'object' || parsedRequestBody === null || Array.isArray(parsedRequestBody)) return null;
    if (JSON.stringify(parsedRequestBody) !== requestBodyText || !Buffer.from(requestBodyText).equals(requestBody)) return null;

    const requestBodyLayout: RequestBodyLayoutField[] = Object.entries(parsedRequestBody).map(([fieldName, fieldValue]) => {
      if (fieldName === 'messages' && Array.isArray(fieldValue)) {
        return {
          field_name: fieldName,
          message_part_ids: fieldValue.map((message) => this.storeRequestBodyPart(JSON.stringify(message), usedOn)),
        };
      }
      const fieldJson = JSON.stringify(fieldValue);
      if (fieldJson.length < shortestRequestBodyPartLength) return { field_name: fieldName, value: fieldValue };
      return { field_name: fieldName, part_id: this.storeRequestBodyPart(fieldJson, usedOn) };
    });
    return zstdCompressSync(Buffer.from(JSON.stringify(requestBodyLayout)));
  }

  /**
   * Returns the ID of the part with this JSON, and stores the part first when it is new. It moves the day of use of
   * the part forward to `usedOn`, so expireRequestContentsStartedBefore keeps every part that a kept request uses.
   */
  private storeRequestBodyPart(partJson: string, usedOn: string): number {
    const partSha256 = createHash('sha256').update(partJson).digest();
    const storedPart = this.database
      .prepare('SELECT id, part_last_used_on FROM request_body_parts WHERE part_sha256 = ?')
      .get(partSha256) as { id: number; part_last_used_on: string | null } | undefined;
    if (storedPart) {
      if (storedPart.part_last_used_on === null || storedPart.part_last_used_on < usedOn) {
        this.database.prepare('UPDATE request_body_parts SET part_last_used_on = ? WHERE id = ?').run(usedOn, storedPart.id);
      }
      return storedPart.id;
    }
    const insertResult = this.database
      .prepare('INSERT INTO request_body_parts (part_sha256, part_json_zstd, part_last_used_on) VALUES (?, ?, ?)')
      .run(partSha256, zstdCompressSync(Buffer.from(partJson)), usedOn);
    return Number(insertResult.lastInsertRowid);
  }

  /** Rebuilds the text of a request body from its layout, or returns its whole stored text. */
  private readRequestBodyText(requestBodyZstd: unknown, requestBodyLayoutZstd: unknown): string | null {
    const requestBodyLayoutText = decompressText(requestBodyLayoutZstd);
    if (requestBodyLayoutText === null) return decompressText(requestBodyZstd);

    const readPart = this.database.prepare('SELECT part_json_zstd FROM request_body_parts WHERE id = ?');
    const readPartJson = (partId: number): string => {
      const part = readPart.get(partId) as { part_json_zstd: Uint8Array } | undefined;
      if (!part) throw new Error(`Request body part ${partId} is missing.`);
      return zstdDecompressSync(part.part_json_zstd).toString('utf8');
    };
    // JSON.stringify of an object joins `"name":value` with commas, so this rebuilds the compact JSON byte for byte.
    const fieldJsons = (JSON.parse(requestBodyLayoutText) as RequestBodyLayoutField[]).map((layoutField) => {
      let valueJson: string;
      if ('message_part_ids' in layoutField) valueJson = `[${layoutField.message_part_ids.map(readPartJson).join(',')}]`;
      else if ('part_id' in layoutField) valueJson = readPartJson(layoutField.part_id);
      else valueJson = JSON.stringify(layoutField.value);
      return `${JSON.stringify(layoutField.field_name)}:${valueJson}`;
    });
    return `{${fieldJsons.join(',')}}`;
  }

  /**
   * Migrates a database made before `is_project_path_inherited` and `upstream_request_id` existed.
   * It reads the project path again from each stored request body, in the order the requests arrived.
   */
  private addProjectPathInheritanceColumns(): void {
    const columnNames = (this.database.prepare('PRAGMA table_info(proxied_requests)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    if (columnNames.includes('is_project_path_inherited')) return;

    this.database.exec('BEGIN');
    try {
      this.database.exec(`
        ALTER TABLE proxied_requests ADD COLUMN is_project_path_inherited INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE proxied_requests ADD COLUMN upstream_request_id TEXT;
        UPDATE proxied_requests SET upstream_request_id = json_extract(response_headers_json, '$."request-id"')
        WHERE response_headers_json IS NOT NULL;
        CREATE INDEX IF NOT EXISTS proxied_requests_upstream_request_id ON proxied_requests (upstream_request_id);
      `);
      const messagesRequestIds = this.database
        .prepare("SELECT id FROM proxied_requests WHERE request_path LIKE '/v1/messages%' ORDER BY id")
        .all() as Array<{ id: number }>;
      const readRequest = this.database.prepare('SELECT session_id, request_body_zstd FROM proxied_requests WHERE id = ?');
      const updateProjectPath = this.database.prepare(
        'UPDATE proxied_requests SET project_path = ?, is_project_path_inherited = ? WHERE id = ?',
      );
      for (const { id: proxiedRequestId } of messagesRequestIds) {
        const storedRequest = readRequest.get(proxiedRequestId) as { session_id: string | null; request_body_zstd: unknown };
        let requestBody: unknown = null;
        try {
          requestBody = JSON.parse(decompressText(storedRequest.request_body_zstd) ?? 'null');
        } catch {
          // A body that is not JSON has no project path.
        }
        const requestContext = extractClaudeCodeRequestContext({}, requestBody);
        const projectPathAssignment = this.assignProjectPath(
          proxiedRequestId,
          storedRequest.session_id,
          requestContext.projectPath,
          requestContext.previousUpstreamRequestId,
        );
        updateProjectPath.run(projectPathAssignment.projectPath, projectPathAssignment.isProjectPathInherited ? 1 : 0, proxiedRequestId);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Gives a request without an environment block the project of the previous request in its conversation.
   * Requests outside a conversation, such as session title requests, get the project of the latest earlier request in the session.
   */
  private assignProjectPath(
    beforeProxiedRequestId: number,
    sessionId: string | null,
    projectPath: string | null,
    previousUpstreamRequestId: string | null,
  ): { projectPath: string | null; isProjectPathInherited: boolean } {
    if (projectPath !== null) return { projectPath, isProjectPathInherited: false };
    const previousRequest = previousUpstreamRequestId
      ? (this.database
          .prepare('SELECT project_path FROM proxied_requests WHERE upstream_request_id = ? AND project_path IS NOT NULL')
          .get(previousUpstreamRequestId) as { project_path: string } | undefined)
      : undefined;
    const latestSessionRequest =
      previousRequest || !sessionId
        ? undefined
        : (this.database
            .prepare(
              `SELECT project_path FROM proxied_requests
               WHERE session_id = ? AND id < ? AND project_path IS NOT NULL ORDER BY id DESC LIMIT 1`,
            )
            .get(sessionId, beforeProxiedRequestId) as { project_path: string } | undefined);
    const inheritedProjectPath = (previousRequest ?? latestSessionRequest)?.project_path ?? null;
    return { projectPath: inheritedProjectPath, isProjectPathInherited: inheritedProjectPath !== null };
  }

  /** Returns the project of a new request: its own project path, or the one inherited from the conversation or the session. */
  findProjectPath(
    sessionId: string | null,
    projectPath: string | null,
    previousUpstreamRequestId: string | null,
  ): { projectPath: string | null; isProjectPathInherited: boolean } {
    return this.assignProjectPath(Number.MAX_SAFE_INTEGER, sessionId, projectPath, previousUpstreamRequestId);
  }

  insertStartedRequest(startedRequest: StartedProxiedRequest): number {
    const projectPathAssignment = this.findProjectPath(
      startedRequest.sessionId,
      startedRequest.projectPath,
      startedRequest.previousUpstreamRequestId,
    );
    this.database.exec('BEGIN');
    try {
      const hasRequestBody = startedRequest.requestBody.length > 0;
      const requestBodyLayout = hasRequestBody
        ? this.storeRequestBodyParts(startedRequest.requestBody, startedRequest.startedAt.slice(0, 10))
        : null;
      const wholeRequestBody = hasRequestBody && requestBodyLayout === null ? zstdCompressSync(startedRequest.requestBody) : null;
      const insertResult = this.database
        .prepare(
          `INSERT INTO proxied_requests (
            started_at, http_method, request_path, client_auth_kind, model, is_streaming, session_id, project_path, project_name,
            is_project_path_inherited, request_headers_json_zstd, request_body_zstd, request_body_layout_zstd, user_text_preview
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          startedRequest.startedAt,
          startedRequest.httpMethod,
          startedRequest.requestPath,
          startedRequest.clientAuthKind,
          startedRequest.model,
          startedRequest.isStreaming ? 1 : 0,
          startedRequest.sessionId,
          projectPathAssignment.projectPath,
          projectPathAssignment.projectPath === null ? null : this.findProjectName(projectPathAssignment.projectPath),
          projectPathAssignment.isProjectPathInherited ? 1 : 0,
          compressText(startedRequest.requestHeadersJson),
          wholeRequestBody,
          requestBodyLayout,
          startedRequest.lastUserMessageText.slice(0, userTextPreviewLength),
        );
      const proxiedRequestId = Number(insertResult.lastInsertRowid);
      this.database
        .prepare('INSERT INTO proxied_request_search_index (rowid, user_text, tool_text, response_text) VALUES (?, ?, ?, ?)')
        .run(proxiedRequestId, startedRequest.lastUserMessageText, startedRequest.lastUserMessageToolResultText, '');
      this.database.exec('COMMIT');
      this.searchTextOfOpenRequests.set(proxiedRequestId, {
        userText: startedRequest.lastUserMessageText,
        toolText: startedRequest.lastUserMessageToolResultText,
      });
      return proxiedRequestId;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  completeRequest(proxiedRequestId: number, completedRequest: CompletedProxiedRequest): void {
    this.database
      .prepare(
        `UPDATE proxied_requests SET
          completed_at = ?, duration_ms = ?, route_kind = ?, route_name = ?, status_code = ?, error_type = ?,
          stop_reason = ?, input_tokens = ?, output_tokens = ?, cache_creation_5m_input_tokens = ?,
          cache_creation_1h_input_tokens = ?, cache_read_input_tokens = ?, estimated_cost_usd = ?,
          response_headers_json_zstd = ?, response_body_zstd = ?, upstream_request_id = json_extract(?, '$."request-id"')
        WHERE id = ?`,
      )
      .run(
        completedRequest.completedAt,
        completedRequest.durationMs,
        completedRequest.routeKind,
        completedRequest.routeName,
        completedRequest.statusCode,
        completedRequest.errorType,
        completedRequest.stopReason,
        completedRequest.inputTokens,
        completedRequest.outputTokens,
        completedRequest.cacheCreation5mInputTokens,
        completedRequest.cacheCreation1hInputTokens,
        completedRequest.cacheReadInputTokens,
        completedRequest.estimatedCostUsd,
        compressText(completedRequest.responseHeadersJson),
        compressText(completedRequest.responseBody),
        completedRequest.responseHeadersJson,
        proxiedRequestId,
      );

    // A request that started before the proxy restarted has no search text here. Its row keeps the request's text.
    const searchTextOfRequest = this.searchTextOfOpenRequests.get(proxiedRequestId);
    if (!searchTextOfRequest) return;
    this.searchTextOfOpenRequests.delete(proxiedRequestId);
    const toolText = [searchTextOfRequest.toolText, completedRequest.responseToolText].filter((text) => text !== '').join('\n');
    this.database.exec('BEGIN');
    try {
      this.database.prepare('DELETE FROM proxied_request_search_index WHERE rowid = ?').run(proxiedRequestId);
      this.database
        .prepare('INSERT INTO proxied_request_search_index (rowid, user_text, tool_text, response_text) VALUES (?, ?, ?, ?)')
        .run(proxiedRequestId, searchTextOfRequest.userText, toolText, completedRequest.responseText);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Deletes the headers, bodies, preview and search text of each request that started before `startedBefore`, and
   * marks the request with `contents_expired_at`. The other fields stay, so the costs and the sessions stay complete.
   * Then it deletes each body part that no kept request uses: a part last used before the day of `startedBefore`.
   * Returns the number of requests whose contents it deleted.
   */
  expireRequestContentsStartedBefore(startedBefore: string): number {
    const expiredAt = new Date().toISOString();
    const readExpiringRequestIds = this.database.prepare(
      'SELECT id FROM proxied_requests WHERE started_at < ? AND contents_expired_at IS NULL ORDER BY started_at LIMIT ?',
    );
    const expireRequestContents = this.database.prepare(
      `UPDATE proxied_requests SET request_headers_json_zstd = NULL, request_body_zstd = NULL, request_body_layout_zstd = NULL,
         response_headers_json_zstd = NULL, response_body_zstd = NULL, user_text_preview = NULL, contents_expired_at = ?
       WHERE id = ?`,
    );
    const deleteSearchText = this.database.prepare('DELETE FROM proxied_request_search_index WHERE rowid = ?');
    let expiredRequestCount = 0;
    for (;;) {
      const expiringRequestIds = readExpiringRequestIds.all(startedBefore, requestBodyPartsSplitBatchSize) as Array<{ id: number }>;
      if (expiringRequestIds.length === 0) break;
      this.database.exec('BEGIN');
      try {
        for (const { id: proxiedRequestId } of expiringRequestIds) {
          expireRequestContents.run(expiredAt, proxiedRequestId);
          deleteSearchText.run(proxiedRequestId);
        }
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
      expiredRequestCount += expiringRequestIds.length;
    }
    this.database.prepare('DELETE FROM request_body_parts WHERE part_last_used_on < ?').run(startedBefore.slice(0, 10));
    return expiredRequestCount;
  }

  insertUpstreamAttempt(upstreamAttempt: UpstreamAttempt): void {
    this.database
      .prepare(
        `INSERT INTO upstream_attempts (
          proxied_request_id, attempt_number, route_kind, route_name, upstream_url, status_code, error_body,
          started_at, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        upstreamAttempt.proxiedRequestId,
        upstreamAttempt.attemptNumber,
        upstreamAttempt.routeKind,
        upstreamAttempt.routeName,
        upstreamAttempt.upstreamUrl,
        upstreamAttempt.statusCode,
        upstreamAttempt.errorBody,
        upstreamAttempt.startedAt,
        upstreamAttempt.durationMs,
      );
  }

  /** Marks requests that were still open when the proxy stopped, so they do not show as pending forever. */
  markUnfinishedRequestsInterrupted(): void {
    this.database
      .prepare("UPDATE proxied_requests SET error_type = 'proxy_restarted', completed_at = started_at WHERE completed_at IS NULL")
      .run();
  }

  readSetting(settingName: string): string | null {
    const settingRow = this.database
      .prepare('SELECT setting_value FROM proxy_settings WHERE setting_name = ?')
      .get(settingName) as { setting_value: string } | undefined;
    return settingRow?.setting_value ?? null;
  }

  writeSetting(settingName: string, settingValue: string | null): void {
    if (settingValue === null) {
      this.database.prepare('DELETE FROM proxy_settings WHERE setting_name = ?').run(settingName);
      return;
    }
    this.database
      .prepare(
        `INSERT INTO proxy_settings (setting_name, setting_value) VALUES (?, ?)
         ON CONFLICT (setting_name) DO UPDATE SET setting_value = excluded.setting_value`,
      )
      .run(settingName, settingValue);
  }

  /**
   * Names the project of every new request with this function, and writes the name of each stored request that differs.
   * `project_path` does not change, because `claude --resume` and the project routes read it.
   * Returns the number of requests that changed.
   */
  applyProjectNames(findProjectName: (projectPath: string) => string): number {
    this.findProjectName = findProjectName;
    const projectPathRows = this.database
      .prepare('SELECT DISTINCT project_path FROM proxied_requests WHERE project_path IS NOT NULL')
      .all() as Array<{ project_path: string }>;
    const updateProjectName = this.database.prepare(
      'UPDATE proxied_requests SET project_name = ? WHERE project_path = ? AND project_name IS NOT ?',
    );
    let changedRequestCount = 0;
    this.database.exec('BEGIN');
    try {
      for (const { project_path: projectPath } of projectPathRows) {
        const projectName = findProjectName(projectPath);
        changedRequestCount += Number(updateProjectName.run(projectName, projectPath, projectName).changes);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return changedRequestCount;
  }

  listProxiedRequests(filters: ProxiedRequestFilters, page: ProxiedRequestPage): Record<string, unknown>[] {
    const { whereClauses, parameters } = buildProxiedRequestConditions(filters);
    if (page.beforeId) {
      whereClauses.push('r.id < ?');
      parameters.push(page.beforeId);
    }
    return this.database
      .prepare(
        `SELECT ${proxiedRequestSummaryColumns}
         FROM proxied_requests r
         ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
         ORDER BY r.id DESC LIMIT ?`,
      )
      .all(...parameters, page.limit) as Record<string, unknown>[];
  }

  /** Sums the estimated cost of the requests that match the filters: in total, since `last30DaysFrom` and since `last24HoursFrom`. */
  summariseProxiedRequestCosts(filters: ProxiedRequestFilters, last30DaysFrom: string, last24HoursFrom: string): Record<string, unknown> {
    const { whereClauses, parameters } = buildProxiedRequestConditions(filters);
    return this.database
      .prepare(
        `SELECT SUM(r.estimated_cost_usd) AS total_cost_usd,
                SUM(CASE WHEN r.started_at >= ? THEN r.estimated_cost_usd END) AS last_30_days_cost_usd,
                SUM(CASE WHEN r.started_at >= ? THEN r.estimated_cost_usd END) AS last_24_hours_cost_usd
         FROM proxied_requests r
         ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}`,
      )
      .get(last30DaysFrom, last24HoursFrom, ...parameters) as Record<string, unknown>;
  }

  readProxiedRequest(proxiedRequestId: number): Record<string, unknown> | null {
    const requestRow = this.database
      .prepare(
        `SELECT ${proxiedRequestSummaryColumns}, r.contents_expired_at, r.request_headers_json_zstd, r.request_body_zstd,
                r.request_body_layout_zstd, r.response_headers_json_zstd, r.response_body_zstd
         FROM proxied_requests r
         WHERE r.id = ?`,
      )
      .get(proxiedRequestId) as Record<string, unknown> | undefined;
    if (!requestRow) return null;

    const {
      request_headers_json_zstd: requestHeadersJsonZstd,
      request_body_zstd: requestBodyZstd,
      request_body_layout_zstd: requestBodyLayoutZstd,
      response_headers_json_zstd: responseHeadersJsonZstd,
      response_body_zstd: responseBodyZstd,
      ...requestFields
    } = requestRow;
    return {
      ...requestFields,
      request_headers_json: decompressText(requestHeadersJsonZstd),
      response_headers_json: decompressText(responseHeadersJsonZstd),
      request_body: this.readRequestBodyText(requestBodyZstd, requestBodyLayoutZstd),
      response_body: decompressText(responseBodyZstd),
      upstream_attempts: this.database
        .prepare('SELECT * FROM upstream_attempts WHERE proxied_request_id = ? ORDER BY attempt_number')
        .all(proxiedRequestId),
    };
  }

  /** Lists the values each filter can take. Models with a request since `recentTrafficFrom` come first. */
  listRequestFilterOptions(recentTrafficFrom: string): Record<string, unknown> {
    const listDistinct = (columnName: string): string[] =>
      (
        this.database
          .prepare(`SELECT DISTINCT ${columnName} AS value FROM proxied_requests WHERE ${columnName} IS NOT NULL ORDER BY 1`)
          .all() as Array<{ value: string }>
      ).map((row) => row.value);
    return {
      models: this.database
        .prepare(
          `SELECT model, MAX(started_at) >= ? AS has_recent_traffic FROM proxied_requests
           WHERE model IS NOT NULL GROUP BY model ORDER BY has_recent_traffic DESC, model`,
        )
        .all(recentTrafficFrom),
      routeNames: listDistinct('route_name'),
      projectNames: listDistinct('project_name'),
    };
  }

  /** Sums tokens and estimated cost per local calendar day and route. */
  summariseCostsByDayAndRoute(startedFrom: string): Record<string, unknown>[] {
    return this.database
      .prepare(
        `SELECT date(started_at, 'localtime') AS day, route_kind, route_name, COUNT(*) AS request_count,
                SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                SUM(cache_creation_5m_input_tokens) + SUM(cache_creation_1h_input_tokens) AS cache_creation_input_tokens,
                SUM(cache_read_input_tokens) AS cache_read_input_tokens,
                SUM(estimated_cost_usd) AS estimated_cost_usd
         FROM proxied_requests
         WHERE started_at >= ? AND route_name IS NOT NULL
         GROUP BY day, route_kind, route_name
         ORDER BY day DESC, route_name`,
      )
      .all(startedFrom) as Record<string, unknown>[];
  }

  /** Lists Claude Code sessions, newest first, with the first user message of each session. */
  listSessions(projectName: string | undefined, limit: number): Record<string, unknown>[] {
    return this.database
      .prepare(
        `SELECT r.session_id, MAX(r.project_path) AS project_path, MAX(r.project_name) AS project_name, MIN(r.started_at) AS first_started_at,
                MAX(r.started_at) AS last_started_at, COUNT(*) AS request_count,
                SUM(r.estimated_cost_usd) AS estimated_cost_usd,
                (SELECT r2.user_text_preview FROM proxied_requests r2
                  WHERE r2.session_id = r.session_id AND r2.user_text_preview != ''
                  ORDER BY r2.id LIMIT 1) AS first_user_text
         FROM proxied_requests r
         WHERE r.session_id IS NOT NULL ${projectName ? 'AND r.project_name = ?' : ''}
         GROUP BY r.session_id
         ORDER BY last_started_at DESC
         LIMIT ?`,
      )
      .all(...(projectName ? [projectName, limit] : [limit])) as Record<string, unknown>[];
  }

  close(): void {
    this.database.close();
  }
}

/** Builds the WHERE conditions for the filters. The query must read `proxied_requests r`. */
function buildProxiedRequestConditions(filters: ProxiedRequestFilters): { whereClauses: string[]; parameters: SQLInputValue[] } {
  const whereClauses: string[] = [];
  const parameters: SQLInputValue[] = [];
  const addCondition = (whereClause: string, ...clauseParameters: SQLInputValue[]) => {
    whereClauses.push(whereClause);
    parameters.push(...clauseParameters);
  };

  if (filters.startedFrom) addCondition('r.started_at >= ?', filters.startedFrom);
  if (filters.startedTo) addCondition('r.started_at < ?', filters.startedTo);
  if (filters.model) addCondition('r.model = ?', filters.model);
  if (filters.routeName) addCondition('r.route_name = ?', filters.routeName);
  if (filters.projectName) addCondition('r.project_name = ?', filters.projectName);
  if (filters.sessionId) addCondition('r.session_id = ?', filters.sessionId);
  if (filters.status === 'pending') addCondition('r.completed_at IS NULL');
  else if (filters.status && /^[1-5]xx$/.test(filters.status)) {
    const statusClass = Number(filters.status[0]);
    addCondition('r.status_code >= ? AND r.status_code < ?', statusClass * 100, statusClass * 100 + 100);
  } else if (filters.status && /^\d{3}$/.test(filters.status)) addCondition('r.status_code = ?', Number(filters.status));
  if (filters.searchText?.trim()) {
    addCondition(
      'r.id IN (SELECT rowid FROM proxied_request_search_index WHERE proxied_request_search_index MATCH ?)',
      toFullTextSearchQuery(filters.searchText),
    );
  }
  return { whereClauses, parameters };
}

/** Quotes each word, so search text never reaches FTS5 as query syntax. A trailing `*` keeps prefix matching. */
function toFullTextSearchQuery(searchText: string): string {
  return searchText
    .trim()
    .split(/\s+/)
    .map((searchWord) => {
      const isPrefixSearch = searchWord.endsWith('*');
      const quotedWord = `"${searchWord.replace(/\*+$/, '').replaceAll('"', '""')}"`;
      return isPrefixSearch ? `${quotedWord}*` : quotedWord;
    })
    .join(' ');
}

function compressText(text: string | null): Uint8Array | null {
  return text === null ? null : zstdCompressSync(Buffer.from(text));
}

function decompressText(compressedValue: unknown): string | null {
  if (!(compressedValue instanceof Uint8Array)) return null;
  return zstdDecompressSync(compressedValue).toString('utf8');
}
