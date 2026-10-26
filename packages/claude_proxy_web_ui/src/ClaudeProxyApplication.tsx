import { useCallback, useState } from 'react';
import { claudeProxyApi, emptyProxiedRequestFilters, type ProxiedRequestFilters, type SubscriptionAccountStatusResponse } from './claude_proxy_api.ts';
import { CostSummaryView } from './CostSummaryView.tsx';
import { ProxiedRequestsView } from './ProxiedRequestsView.tsx';
import type { RouteDotAppearance } from './RouteDot.tsx';
import { SessionsView } from './SessionsView.tsx';
import { SubscriptionAccountsPanel } from './SubscriptionAccountsPanel.tsx';
import { usePolling } from './use_polling.ts';

type ApplicationView = 'requests' | 'sessions' | 'costs';

const applicationViewLabels: Record<ApplicationView, string> = {
  requests: 'Requests',
  sessions: 'Sessions',
  costs: 'Costs',
};

const subscriptionRouteAppearance: RouteDotAppearance = { letter: 'S', colour: '#ffffff' };
const passthroughRouteAppearance: RouteDotAppearance = { letter: 'K', colour: '#9aa3ae' };
const unknownRouteAppearance: RouteDotAppearance = { letter: '?', colour: '#9aa3ae' };

export function ClaudeProxyApplication() {
  const [accountStatus, setAccountStatus] = useState<SubscriptionAccountStatusResponse | null>(null);
  const [accountStatusError, setAccountStatusError] = useState<string | null>(null);
  const [applicationView, setApplicationView] = useState<ApplicationView>('requests');
  const [requestFilters, setRequestFilters] = useState<ProxiedRequestFilters>(emptyProxiedRequestFilters);

  usePolling(
    () =>
      claudeProxyApi.readSubscriptionAccountStatus().then(
        (latestAccountStatus) => {
          setAccountStatus(latestAccountStatus);
          setAccountStatusError(null);
        },
        (error: Error) => setAccountStatusError(error.message),
      ),
    5000,
    [],
  );

  /** Finds the dot for a route name in a recorded request. Names that match no account in the configuration show a grey "?". */
  const findRouteAppearance = useCallback(
    (routeName: string | null): RouteDotAppearance => {
      if (routeName === 'subscription') return subscriptionRouteAppearance;
      if (routeName === 'passthrough') return passthroughRouteAppearance;
      const subscriptionAccount = accountStatus?.subscriptionAccounts.find((candidateAccount) => candidateAccount.subscriptionAccountName === routeName);
      if (subscriptionAccount) return { colour: subscriptionAccount.colour };
      return unknownRouteAppearance;
    },
    [accountStatus],
  );

  const showSessionRequests = (sessionId: string) => {
    setRequestFilters({ ...emptyProxiedRequestFilters, sessionId });
    setApplicationView('requests');
  };

  return (
    <div className="application">
      <SubscriptionAccountsPanel
        accountStatus={accountStatus}
        accountStatusError={accountStatusError}
        onAccountStatusChange={setAccountStatus}
      />
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
