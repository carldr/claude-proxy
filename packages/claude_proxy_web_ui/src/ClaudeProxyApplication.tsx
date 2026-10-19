import { useCallback, useState } from 'react';
import { claudeProxyApi, emptyProxiedRequestFilters, type ProxiedRequestFilters, type RoutingStatus } from './claude_proxy_api.ts';
import { CostSummaryView } from './CostSummaryView.tsx';
import { ProxiedRequestsView } from './ProxiedRequestsView.tsx';
import type { RouteDotAppearance } from './RouteDot.tsx';
import { RoutingPanel } from './RoutingPanel.tsx';
import { SessionsView } from './SessionsView.tsx';
import { usePolling } from './use_polling.ts';

type ApplicationView = 'requests' | 'sessions' | 'costs';

const applicationViewLabels: Record<ApplicationView, string> = {
  requests: 'Requests',
  sessions: 'Sessions',
  costs: 'Costs',
};

const subscriptionRouteAppearance: RouteDotAppearance = { letter: 'S', colour: '#ffffff' };
const unknownRouteAppearance: RouteDotAppearance = { letter: '?', colour: '#9aa3ae' };

export function ClaudeProxyApplication() {
  const [routingStatus, setRoutingStatus] = useState<RoutingStatus | null>(null);
  const [routingStatusError, setRoutingStatusError] = useState<string | null>(null);
  const [applicationView, setApplicationView] = useState<ApplicationView>('requests');
  const [requestFilters, setRequestFilters] = useState<ProxiedRequestFilters>(emptyProxiedRequestFilters);

  usePolling(
    () =>
      claudeProxyApi.readRoutingStatus().then(
        (latestRoutingStatus) => {
          setRoutingStatus(latestRoutingStatus);
          setRoutingStatusError(null);
        },
        (error: Error) => setRoutingStatusError(error.message),
      ),
    5000,
    [],
  );

  /** Finds the dot for a route name in a recorded request. Routes removed from routes.yml show a grey "?". */
  const findRouteAppearance = useCallback(
    (routeName: string | null): RouteDotAppearance => {
      if (routeName === 'subscription') return subscriptionRouteAppearance;
      const apiKeyRoute = routingStatus?.apiKeyRoutes.find((candidateRoute) => candidateRoute.routeName === routeName);
      if (apiKeyRoute) return apiKeyRoute;
      if (routeName === 'passthrough') return { letter: 'K', colour: '#9aa3ae' };
      return unknownRouteAppearance;
    },
    [routingStatus],
  );

  const showSessionRequests = (sessionId: string) => {
    setRequestFilters({ ...emptyProxiedRequestFilters, sessionId });
    setApplicationView('requests');
  };

  return (
    <div className="application">
      <RoutingPanel routingStatus={routingStatus} routingStatusError={routingStatusError} onRoutingStatusChange={setRoutingStatus} />
      <nav className="view-tabs" role="tablist">
        {(Object.keys(applicationViewLabels) as ApplicationView[]).map((candidateView) => (
          <button
            key={candidateView}
            role="tab"
            aria-selected={applicationView === candidateView}
            onClick={() => setApplicationView(candidateView)}
          >
            {applicationViewLabels[candidateView]}
          </button>
        ))}
      </nav>
      <main className="view-body">
        {applicationView === 'requests' && (
          <ProxiedRequestsView filters={requestFilters} onFiltersChange={setRequestFilters} findRouteAppearance={findRouteAppearance} />
        )}
        {applicationView === 'sessions' && <SessionsView onShowSessionRequests={showSessionRequests} />}
        {applicationView === 'costs' && <CostSummaryView findRouteAppearance={findRouteAppearance} />}
      </main>
    </div>
  );
}
