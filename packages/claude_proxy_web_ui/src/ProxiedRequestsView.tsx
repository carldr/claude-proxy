import { useEffect, useState } from 'react';
import {
  claudeProxyApi,
  type ProxiedRequestFilters,
  type ProxiedRequestSummary,
  type RequestFilterOptions,
} from './claude_proxy_api.ts';
import {
  formatCostUsd,
  formatDuration,
  formatTimestamp,
  formatTokenCount,
  shortenProjectPath,
  totalInputTokens,
} from './display_formatting.ts';
import { ProxiedRequestDetailPanel } from './ProxiedRequestDetailPanel.tsx';
import { RouteDot, type RouteDotAppearance } from './RouteDot.tsx';
import { usePolling } from './use_polling.ts';

interface ProxiedRequestsViewProperties {
  filters: ProxiedRequestFilters;
  onFiltersChange: (filters: ProxiedRequestFilters) => void;
  findRouteAppearance: (routeName: string | null) => RouteDotAppearance;
}

const statusFilterOptions = [
  { value: '', label: 'Any status' },
  { value: '2xx', label: 'Succeeded (2xx)' },
  { value: '4xx', label: 'Client errors (4xx)' },
  { value: '429', label: 'Rate limited (429)' },
  { value: '5xx', label: 'Server errors (5xx)' },
  { value: 'pending', label: 'In progress' },
];

export function ProxiedRequestsView({ filters, onFiltersChange, findRouteAppearance }: ProxiedRequestsViewProperties) {
  const [proxiedRequests, setProxiedRequests] = useState<ProxiedRequestSummary[]>([]);
  const [hasOlderRequests, setHasOlderRequests] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [filterOptions, setFilterOptions] = useState<RequestFilterOptions>({ models: [], routeNames: [], projectPaths: [] });
  const [selectedRequestId, setSelectedRequestId] = useState<number | null>(null);
  const [searchTextDraft, setSearchTextDraft] = useState(filters.searchText);

  useEffect(() => setSearchTextDraft(filters.searchText), [filters.searchText]);
  useEffect(() => {
    if (searchTextDraft === filters.searchText) return;
    const searchTimer = setTimeout(() => onFiltersChange({ ...filters, searchText: searchTextDraft }), 300);
    return () => clearTimeout(searchTimer);
  }, [searchTextDraft, filters, onFiltersChange]);

  useEffect(() => {
    void claudeProxyApi.readRequestFilterOptions().then(setFilterOptions, () => undefined);
  }, []);

  // Reloads the newest page, and keeps older pages that "Show older requests" loaded.
  usePolling(
    () =>
      claudeProxyApi.listProxiedRequests(filters).then(
        (newestRequests) => {
          setListError(null);
          setProxiedRequests((currentRequests) => {
            const oldestNewestId = newestRequests.at(-1)?.id ?? Infinity;
            const olderRequests = currentRequests.filter((currentRequest) => currentRequest.id < oldestNewestId);
            return [...newestRequests, ...olderRequests];
          });
          setHasOlderRequests((hadOlderRequests) => hadOlderRequests || newestRequests.length === 100);
        },
        (error: Error) => setListError(error.message),
      ),
    5000,
    [filters],
  );

  useEffect(() => {
    setProxiedRequests([]);
    setHasOlderRequests(false);
  }, [filters]);

  const loadOlderRequests = () => {
    const oldestRequestId = proxiedRequests.at(-1)?.id;
    void claudeProxyApi.listProxiedRequests(filters, oldestRequestId).then((olderRequests) => {
      setProxiedRequests((currentRequests) => [...currentRequests, ...olderRequests]);
      setHasOlderRequests(olderRequests.length === 100);
    });
  };

  const updateFilter = (filterName: keyof ProxiedRequestFilters, filterValue: string) => onFiltersChange({ ...filters, [filterName]: filterValue });

  return (
    <div className="requests-view" data-has-detail={selectedRequestId !== null}>
      <section className="requests-list">
        <div className="request-filters">
          <input
            type="search"
            placeholder="Search prompts, replies and tool output"
            aria-label="Search prompts, replies and tool output"
            value={searchTextDraft}
            onChange={(changeEvent) => setSearchTextDraft(changeEvent.target.value)}
          />
          <select aria-label="Project" value={filters.projectPath} onChange={(changeEvent) => updateFilter('projectPath', changeEvent.target.value)}>
            <option value="">All projects</option>
            {filterOptions.projectPaths.map((projectPath) => (
              <option key={projectPath} value={projectPath}>
                {shortenProjectPath(projectPath)}
              </option>
            ))}
          </select>
          <select aria-label="Model" value={filters.model} onChange={(changeEvent) => updateFilter('model', changeEvent.target.value)}>
            <option value="">All models</option>
            {filterOptions.models.map((model) => (
              <option key={model}>{model}</option>
            ))}
          </select>
          <select aria-label="Route" value={filters.routeName} onChange={(changeEvent) => updateFilter('routeName', changeEvent.target.value)}>
            <option value="">All routes</option>
            {filterOptions.routeNames.map((routeName) => (
              <option key={routeName}>{routeName}</option>
            ))}
          </select>
          <select aria-label="Status" value={filters.status} onChange={(changeEvent) => updateFilter('status', changeEvent.target.value)}>
            {statusFilterOptions.map((statusOption) => (
              <option key={statusOption.value} value={statusOption.value}>
                {statusOption.label}
              </option>
            ))}
          </select>
          <input type="date" aria-label="From date" value={filters.startedFrom} onChange={(changeEvent) => updateFilter('startedFrom', changeEvent.target.value)} />
          <input type="date" aria-label="To date" value={filters.startedTo} onChange={(changeEvent) => updateFilter('startedTo', changeEvent.target.value)} />
          {filters.sessionId && (
            <span className="session-filter">
              Session {filters.sessionId.slice(0, 8)}
              <button aria-label="Show all sessions" onClick={() => updateFilter('sessionId', '')}>
                ×
              </button>
            </span>
          )}
        </div>

        <div className="table-scroller">
          {listError && <p className="empty-state status-error">The request list did not load: {listError}</p>}
          {!listError && proxiedRequests.length === 0 && (
            <p className="empty-state">
              No requests match. Start Claude Code with <code>ANTHROPIC_BASE_URL=http://127.0.0.1:4100</code> to send requests through the proxy.
            </p>
          )}
          {proxiedRequests.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th className="numeric">ID</th>
                  <th>Time</th>
                  <th>Route</th>
                  <th>Model</th>
                  <th>Project</th>
                  <th>Prompt</th>
                  <th className="numeric">Input</th>
                  <th className="numeric">Output</th>
                  <th className="numeric">Cost</th>
                  <th>Status</th>
                  <th className="numeric">Duration</th>
                </tr>
              </thead>
              <tbody>
                {proxiedRequests.map((proxiedRequest) => (
                  <tr
                    key={proxiedRequest.id}
                    data-clickable="true"
                    aria-selected={proxiedRequest.id === selectedRequestId}
                    tabIndex={0}
                    onClick={() => setSelectedRequestId(proxiedRequest.id)}
                    onKeyDown={(keyEvent) => keyEvent.key === 'Enter' && setSelectedRequestId(proxiedRequest.id)}
                  >
                    <td className="numeric muted">{proxiedRequest.id}</td>
                    <td>{formatTimestamp(proxiedRequest.started_at)}</td>
                    <td>
                      <span className="route-cell" title={proxiedRequest.route_name ?? 'Not routed yet'}>
                        <RouteDot routeAppearance={findRouteAppearance(proxiedRequest.route_name)} />
                        {proxiedRequest.upstream_attempt_count > 1 && <span className="muted">{proxiedRequest.upstream_attempt_count} tries</span>}
                      </span>
                    </td>
                    <td>{proxiedRequest.model ?? <span className="muted">{proxiedRequest.request_path}</span>}</td>
                    <td className="project-name" title={proxiedRequest.project_path ?? ''}>{shortenProjectPath(proxiedRequest.project_path)}</td>
                    <td className="prompt-preview" title={proxiedRequest.user_text_preview ?? ''}>
                      {proxiedRequest.user_text_preview || <span className="muted">{proxiedRequest.stop_reason === null ? '' : 'Tool results'}</span>}
                    </td>
                    <td className="numeric">{formatTokenCount(totalInputTokens(proxiedRequest))}</td>
                    <td className="numeric">{formatTokenCount(proxiedRequest.output_tokens)}</td>
                    <td className="numeric">{formatCostUsd(proxiedRequest.estimated_cost_usd)}</td>
                    <td>
                      <RequestStatus proxiedRequest={proxiedRequest} />
                    </td>
                    <td className="numeric">{formatDuration(proxiedRequest.duration_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {hasOlderRequests && (
            <div className="list-footer">
              <button onClick={loadOlderRequests}>Show older requests</button>
            </div>
          )}
        </div>
      </section>

      {selectedRequestId !== null && (
        <ProxiedRequestDetailPanel
          proxiedRequestId={selectedRequestId}
          findRouteAppearance={findRouteAppearance}
          onClose={() => setSelectedRequestId(null)}
          onShowSession={(sessionId) => onFiltersChange({ ...filters, sessionId })}
        />
      )}
    </div>
  );
}

export function RequestStatus({ proxiedRequest }: { proxiedRequest: ProxiedRequestSummary }) {
  if (proxiedRequest.completed_at === null) return <span className="muted">In progress</span>;
  const isError = proxiedRequest.status_code === null || proxiedRequest.status_code >= 400 || proxiedRequest.error_type !== null;
  return (
    <span className={isError ? 'status-error' : 'status-ok'} title={proxiedRequest.error_type ?? undefined}>
      {proxiedRequest.status_code ?? proxiedRequest.error_type}
      {proxiedRequest.status_code !== null && proxiedRequest.error_type !== null && ` ${proxiedRequest.error_type}`}
    </span>
  );
}
