export interface SubscriptionAccountUsageWindow {
  usageWindowName: string;
  /** A fraction from 0 to 1. */
  utilization: number;
  resetsAt: string | null;
}

export interface SubscriptionAccountStatus {
  subscriptionAccountName: string;
  colour: string;
  emailAddress: string | null;
  loginState: 'logged_in' | 'login_required';
  weeklyUtilization: number | null;
  isBlocked: boolean;
  /** Null while `isBlocked` is true means the account is at the failover utilization of a window. */
  blockedUntil: string | null;
  /** The window of the whole-account block, such as `five_hour` or `seven_day`. Null when no such block is active. */
  blockedRateLimitWindow: string | null;
  usageWindows: SubscriptionAccountUsageWindow[];
  usageCheckedAt: string | null;
}

export interface SubscriptionAccountStatusResponse {
  subscriptionAccounts: SubscriptionAccountStatus[];
  /** The fraction of a 5-hour or weekly window at which the proxy avoids an account. */
  failoverUtilization: number;
  configErrors: string[];
}

export interface SubscriptionAccountUsageCheckResponse extends SubscriptionAccountStatusResponse {
  usageCheckErrors: string[];
}

export interface ProxiedRequestSummary {
  id: number;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  http_method: string;
  request_path: string;
  client_auth_kind: string;
  route_kind: string | null;
  route_name: string | null;
  model: string | null;
  is_streaming: number;
  session_id: string | null;
  project_path: string | null;
  /** 1 when the request carried no environment block and `project_path` comes from an earlier request in its session. */
  is_project_path_inherited: number;
  status_code: number | null;
  error_type: string | null;
  stop_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_5m_input_tokens: number | null;
  cache_creation_1h_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  estimated_cost_usd: number | null;
  upstream_attempt_count: number;
  user_text_preview: string | null;
}

export interface UpstreamAttempt {
  attempt_number: number;
  route_kind: string;
  route_name: string;
  upstream_url: string;
  status_code: number | null;
  error_body: string | null;
  started_at: string;
  duration_ms: number;
}

export interface ProxiedRequestDetail extends ProxiedRequestSummary {
  request_headers_json: string;
  request_body: string | null;
  response_headers_json: string | null;
  response_body: string | null;
  user_text: string;
  response_text: string;
  upstream_attempts: UpstreamAttempt[];
}

export interface ProxiedRequestFilters {
  searchText: string;
  model: string;
  routeName: string;
  status: string;
  projectPath: string;
  sessionId: string;
  startedFrom: string;
  startedTo: string;
}

export const emptyProxiedRequestFilters: ProxiedRequestFilters = {
  searchText: '',
  model: '',
  routeName: '',
  status: '',
  projectPath: '',
  sessionId: '',
  startedFrom: '',
  startedTo: '',
};

export interface ProxiedRequestCostTotals {
  total_cost_usd: number | null;
  last_30_days_cost_usd: number | null;
  last_24_hours_cost_usd: number | null;
}

export interface RequestFilterOptions {
  /** Models with a request in the last 30 days come first. */
  models: Array<{ model: string; has_recent_traffic: number }>;
  routeNames: string[];
  projectPaths: string[];
}

export interface ClaudeCodeSession {
  session_id: string;
  project_path: string | null;
  first_started_at: string;
  last_started_at: string;
  request_count: number;
  estimated_cost_usd: number | null;
  first_user_text: string | null;
  session_log_file_path: string | null;
}

export interface DailyRouteCost {
  day: string;
  route_kind: string;
  route_name: string;
  request_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  estimated_cost_usd: number | null;
}

const apiBasePath = '/_proxy/api/';

function buildFilterQueryParameters(filters: ProxiedRequestFilters): URLSearchParams {
  const queryParameters = new URLSearchParams();
  for (const [filterName, filterValue] of Object.entries(filters)) {
    if (filterValue === '') continue;
    // The date inputs give local dates; the database stores UTC timestamps.
    if (filterName === 'startedFrom') queryParameters.set(filterName, new Date(`${filterValue}T00:00`).toISOString());
    else if (filterName === 'startedTo') queryParameters.set(filterName, new Date(new Date(`${filterValue}T00:00`).getTime() + 86_400_000).toISOString());
    else queryParameters.set(filterName, filterValue);
  }
  return queryParameters;
}

async function requestApi<ResponseType>(apiPath: string, requestInit?: RequestInit): Promise<ResponseType> {
  const apiResponse = await fetch(`${apiBasePath}${apiPath}`, requestInit);
  const responseValue = await apiResponse.json();
  if (!apiResponse.ok) throw new Error(responseValue.error ?? `HTTP ${apiResponse.status}`);
  return responseValue as ResponseType;
}

export const claudeProxyApi = {
  readSubscriptionAccountStatus: () => requestApi<SubscriptionAccountStatusResponse>('subscription-account-status'),
  checkSubscriptionAccountUsage: () =>
    requestApi<SubscriptionAccountUsageCheckResponse>('subscription-account-usage-check', { method: 'POST' }),
  startSubscriptionAccountLogin: (subscriptionAccountName: string) =>
    requestApi<{ authorizeUrl: string }>(`subscription-accounts/${encodeURIComponent(subscriptionAccountName)}/login`, { method: 'POST' }),
  listProxiedRequests: (filters: ProxiedRequestFilters, beforeId?: number) => {
    const queryParameters = buildFilterQueryParameters(filters);
    if (beforeId !== undefined) queryParameters.set('beforeId', String(beforeId));
    queryParameters.set('limit', '100');
    return requestApi<ProxiedRequestSummary[]>(`proxied-requests?${queryParameters}`);
  },
  readProxiedRequestCostTotals: (filters: ProxiedRequestFilters) =>
    requestApi<ProxiedRequestCostTotals>(`proxied-request-cost-totals?${buildFilterQueryParameters(filters)}`),
  readProxiedRequest: (proxiedRequestId: number) => requestApi<ProxiedRequestDetail>(`proxied-requests/${proxiedRequestId}`),
  readRequestFilterOptions: () => requestApi<RequestFilterOptions>('request-filter-options'),
  listSessions: (projectPath: string) =>
    requestApi<ClaudeCodeSession[]>(`sessions?${new URLSearchParams(projectPath ? { projectPath } : {})}`),
  readCostSummary: (dayCount: number) => requestApi<DailyRouteCost[]>(`cost-summary?days=${dayCount}`),
};
