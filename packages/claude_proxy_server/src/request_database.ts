import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

export type RouteKind = 'subscription' | 'api_key' | 'passthrough';
export type ClientAuthKind = 'oauth' | 'api_key' | 'none';

export interface StartedProxiedRequest {
  startedAt: string;
  httpMethod: string;
  requestPath: string;
  clientAuthKind: ClientAuthKind;
  model: string | null;
  isStreaming: boolean;
  sessionId: string | null;
  projectPath: string | null;
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
  projectPath?: string;
  sessionId?: string;
  searchText?: string;
  beforeId?: number;
  limit: number;
}

const proxiedRequestSummaryColumns = `
  r.id, r.started_at, r.completed_at, r.duration_ms, r.http_method, r.request_path, r.client_auth_kind,
  r.route_kind, r.route_name, r.model, r.is_streaming, r.session_id, r.project_path, r.status_code,
  r.error_type, r.stop_reason, r.input_tokens, r.output_tokens, r.cache_creation_5m_input_tokens,
  r.cache_creation_1h_input_tokens, r.cache_read_input_tokens, r.estimated_cost_usd,
  (SELECT COUNT(*) FROM upstream_attempts a WHERE a.proxied_request_id = r.id) AS upstream_attempt_count,
  substr(s.user_text, 1, 300) AS user_text_preview`;

/**
 * Stores every proxied request in SQLite. Request and response bodies are compressed with zstd,
 * because Claude Code sends the whole conversation with each request.
 */
export class RequestDatabase {
  private readonly database: DatabaseSync;

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
        status_code INTEGER,
        error_type TEXT,
        stop_reason TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_creation_5m_input_tokens INTEGER,
        cache_creation_1h_input_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        estimated_cost_usd REAL,
        request_headers_json TEXT NOT NULL,
        request_body_zstd BLOB,
        response_headers_json TEXT,
        response_body_zstd BLOB
      );
      CREATE INDEX IF NOT EXISTS proxied_requests_started_at ON proxied_requests (started_at);
      CREATE INDEX IF NOT EXISTS proxied_requests_session_id ON proxied_requests (session_id);
      CREATE INDEX IF NOT EXISTS proxied_requests_project_path ON proxied_requests (project_path);
      CREATE INDEX IF NOT EXISTS proxied_requests_model ON proxied_requests (model);
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

      -- rowid is proxied_requests.id. Each request repeats the whole conversation, so the index holds only what
      -- is new in each request: user_text is the last user message; tool_text is the tool results in that
      -- message plus the tool calls and thinking of the response; response_text is the text of the response.
      CREATE VIRTUAL TABLE IF NOT EXISTS proxied_request_search USING fts5 (user_text, tool_text, response_text);

      CREATE TABLE IF NOT EXISTS proxy_settings (
        setting_name TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL
      );
    `);
  }

  insertStartedRequest(startedRequest: StartedProxiedRequest): number {
    const insertResult = this.database
      .prepare(
        `INSERT INTO proxied_requests (
          started_at, http_method, request_path, client_auth_kind, model, is_streaming, session_id, project_path,
          request_headers_json, request_body_zstd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        startedRequest.startedAt,
        startedRequest.httpMethod,
        startedRequest.requestPath,
        startedRequest.clientAuthKind,
        startedRequest.model,
        startedRequest.isStreaming ? 1 : 0,
        startedRequest.sessionId,
        startedRequest.projectPath,
        startedRequest.requestHeadersJson,
        startedRequest.requestBody.length > 0 ? zstdCompressSync(startedRequest.requestBody) : null,
      );
    const proxiedRequestId = Number(insertResult.lastInsertRowid);
    this.database
      .prepare('INSERT INTO proxied_request_search (rowid, user_text, tool_text, response_text) VALUES (?, ?, ?, ?)')
      .run(proxiedRequestId, startedRequest.lastUserMessageText, startedRequest.lastUserMessageToolResultText, '');
    return proxiedRequestId;
  }

  completeRequest(proxiedRequestId: number, completedRequest: CompletedProxiedRequest): void {
    this.database
      .prepare(
        `UPDATE proxied_requests SET
          completed_at = ?, duration_ms = ?, route_kind = ?, route_name = ?, status_code = ?, error_type = ?,
          stop_reason = ?, input_tokens = ?, output_tokens = ?, cache_creation_5m_input_tokens = ?,
          cache_creation_1h_input_tokens = ?, cache_read_input_tokens = ?, estimated_cost_usd = ?,
          response_headers_json = ?, response_body_zstd = ?
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
        completedRequest.responseHeadersJson,
        completedRequest.responseBody === null ? null : zstdCompressSync(Buffer.from(completedRequest.responseBody)),
        proxiedRequestId,
      );
    this.database
      .prepare(
        `UPDATE proxied_request_search
         SET response_text = ?, tool_text = CASE WHEN tool_text = '' THEN ? ELSE tool_text || char(10) || ? END
         WHERE rowid = ?`,
      )
      .run(completedRequest.responseText, completedRequest.responseToolText, completedRequest.responseToolText, proxiedRequestId);
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

  listProxiedRequests(filters: ProxiedRequestFilters): Record<string, unknown>[] {
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
    if (filters.projectPath) addCondition('r.project_path = ?', filters.projectPath);
    if (filters.sessionId) addCondition('r.session_id = ?', filters.sessionId);
    if (filters.beforeId) addCondition('r.id < ?', filters.beforeId);
    if (filters.status === 'pending') addCondition('r.completed_at IS NULL');
    else if (filters.status && /^[1-5]xx$/.test(filters.status)) {
      const statusClass = Number(filters.status[0]);
      addCondition('r.status_code >= ? AND r.status_code < ?', statusClass * 100, statusClass * 100 + 100);
    } else if (filters.status && /^\d{3}$/.test(filters.status)) addCondition('r.status_code = ?', Number(filters.status));
    if (filters.searchText?.trim()) {
      addCondition('s.proxied_request_search MATCH ?', toFullTextSearchQuery(filters.searchText));
    }

    return this.database
      .prepare(
        `SELECT ${proxiedRequestSummaryColumns}
         FROM proxied_requests r JOIN proxied_request_search s ON s.rowid = r.id
         ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
         ORDER BY r.id DESC LIMIT ?`,
      )
      .all(...parameters, filters.limit) as Record<string, unknown>[];
  }

  readProxiedRequest(proxiedRequestId: number): Record<string, unknown> | null {
    const requestRow = this.database
      .prepare(
        `SELECT ${proxiedRequestSummaryColumns}, r.request_headers_json, r.request_body_zstd, r.response_headers_json,
                r.response_body_zstd, s.user_text, s.tool_text, s.response_text
         FROM proxied_requests r JOIN proxied_request_search s ON s.rowid = r.id
         WHERE r.id = ?`,
      )
      .get(proxiedRequestId) as Record<string, unknown> | undefined;
    if (!requestRow) return null;

    const { request_body_zstd: requestBodyZstd, response_body_zstd: responseBodyZstd, ...requestFields } = requestRow;
    return {
      ...requestFields,
      request_body: decompressText(requestBodyZstd),
      response_body: decompressText(responseBodyZstd),
      upstream_attempts: this.database
        .prepare('SELECT * FROM upstream_attempts WHERE proxied_request_id = ? ORDER BY attempt_number')
        .all(proxiedRequestId),
    };
  }

  listRequestFilterOptions(): Record<string, string[]> {
    const listDistinct = (columnName: string): string[] =>
      (
        this.database
          .prepare(`SELECT DISTINCT ${columnName} AS value FROM proxied_requests WHERE ${columnName} IS NOT NULL ORDER BY 1`)
          .all() as Array<{ value: string }>
      ).map((row) => row.value);
    return {
      models: listDistinct('model'),
      routeNames: listDistinct('route_name'),
      projectPaths: listDistinct('project_path'),
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
  listSessions(projectPath: string | undefined, limit: number): Record<string, unknown>[] {
    return this.database
      .prepare(
        `SELECT r.session_id, MAX(r.project_path) AS project_path, MIN(r.started_at) AS first_started_at,
                MAX(r.started_at) AS last_started_at, COUNT(*) AS request_count,
                SUM(r.estimated_cost_usd) AS estimated_cost_usd,
                (SELECT substr(s.user_text, 1, 300)
                   FROM proxied_requests r2 JOIN proxied_request_search s ON s.rowid = r2.id
                  WHERE r2.session_id = r.session_id AND s.user_text != ''
                  ORDER BY r2.id LIMIT 1) AS first_user_text
         FROM proxied_requests r
         WHERE r.session_id IS NOT NULL ${projectPath ? 'AND r.project_path = ?' : ''}
         GROUP BY r.session_id
         ORDER BY last_started_at DESC
         LIMIT ?`,
      )
      .all(...(projectPath ? [projectPath, limit] : [limit])) as Record<string, unknown>[];
  }

  close(): void {
    this.database.close();
  }
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

function decompressText(compressedValue: unknown): string | null {
  if (!(compressedValue instanceof Uint8Array)) return null;
  return zstdDecompressSync(compressedValue).toString('utf8');
}
