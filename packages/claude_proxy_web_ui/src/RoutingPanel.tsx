import { useState } from 'react';
import { claudeProxyApi, type RoutingMode, type RoutingStatus } from './claude_proxy_api.ts';
import { RouteDot } from './RouteDot.tsx';

const routingModeLabels: Record<RoutingMode, string> = {
  auto: 'Auto',
  force_subscription: 'Subscription only',
  force_api_key: 'API key only',
};

interface RoutingPanelProperties {
  routingStatus: RoutingStatus | null;
  routingStatusError: string | null;
  onRoutingStatusChange: (routingStatus: RoutingStatus) => void;
}

/** Shows where subscription traffic goes now, the controls that decide it, and the weekly subscription usage. */
export function RoutingPanel({ routingStatus, routingStatusError, onRoutingStatusChange }: RoutingPanelProperties) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [isCheckingUsage, setIsCheckingUsage] = useState(false);

  if (!routingStatus) {
    return (
      <header className="routing-panel">
        <span className="muted">{routingStatusError ? `The proxy does not answer: ${routingStatusError}` : 'Loading routing status'}</span>
      </header>
    );
  }

  const runRoutingAction = (routingAction: () => Promise<RoutingStatus>) =>
    routingAction().then(
      (latestRoutingStatus) => {
        onRoutingStatusChange(latestRoutingStatus);
        setActionError(latestRoutingStatus.subscriptionUsageCheckError ?? null);
      },
      (error: Error) => setActionError(error.message),
    );

  const checkUsageNow = () => {
    setIsCheckingUsage(true);
    void runRoutingAction(claudeProxyApi.checkSubscriptionUsage).finally(() => setIsCheckingUsage(false));
  };

  const errorMessages = [...routingStatus.configErrors, ...(routingStatusError ? [routingStatusError] : []), ...(actionError ? [actionError] : [])];

  return (
    <header className="routing-panel">
      <div className="active-route">
        <RouteDot routeAppearance={routingStatus.activeRoute} size={36} />
        <div>
          <div className="active-route-name">
            {routingStatus.activeRoute.routeKind === 'subscription' ? 'Subscription' : routingStatus.activeRoute.routeName}
          </div>
          <div className="active-route-reason">{describeRoutingReason(routingStatus)}</div>
        </div>
      </div>

      <div className="routing-controls">
        <div className="routing-mode-switch" role="group" aria-label="Routing mode">
          {(Object.keys(routingModeLabels) as RoutingMode[]).map((routingMode) => (
            <button
              key={routingMode}
              aria-pressed={routingStatus.routingMode === routingMode}
              onClick={() => void runRoutingAction(() => claudeProxyApi.updateRoutingSettings({ routingMode }))}
            >
              {routingModeLabels[routingMode]}
            </button>
          ))}
        </div>
        <label>
          First API key
          <select
            value={routingStatus.selectedApiKeyRouteName ?? routingStatus.apiKeyRoutes[0]?.routeName ?? ''}
            disabled={routingStatus.apiKeyRoutes.length === 0}
            onChange={(changeEvent) =>
              void runRoutingAction(() => claudeProxyApi.updateRoutingSettings({ selectedApiKeyRouteName: changeEvent.target.value }))
            }
          >
            {routingStatus.apiKeyRoutes.length === 0 && <option value="">None in routes.yml</option>}
            {routingStatus.apiKeyRoutes.map((apiKeyRoute) => (
              <option key={apiKeyRoute.routeName} value={apiKeyRoute.routeName}>
                {apiKeyRoute.letter}: {apiKeyRoute.routeName}
              </option>
            ))}
          </select>
        </label>
      </div>

      <WeeklyUsageGauge routingStatus={routingStatus} isCheckingUsage={isCheckingUsage} onCheckUsageNow={checkUsageNow} />

      {errorMessages.length > 0 && <p className="config-errors">{errorMessages.join('\n')}</p>}
    </header>
  );
}

function WeeklyUsageGauge({
  routingStatus,
  isCheckingUsage,
  onCheckUsageNow,
}: {
  routingStatus: RoutingStatus;
  isCheckingUsage: boolean;
  onCheckUsageNow: () => void;
}) {
  const weeklyUtilization = routingStatus.subscriptionWeeklyUtilization;
  const weeklyResetsAt = routingStatus.subscriptionWeeklyResetsAt ? new Date(routingStatus.subscriptionWeeklyResetsAt) : null;

  return (
    <section className="weekly-usage" aria-label="Weekly subscription usage">
      <div className="weekly-usage-heading">
        <span>
          <span className="weekly-usage-percent">{weeklyUtilization === null ? 'Unknown' : `${Math.round(weeklyUtilization * 100)}%`}</span>{' '}
          <span className="muted">of the weekly subscription limit</span>
        </span>
        <button className="text-button" onClick={onCheckUsageNow} disabled={isCheckingUsage}>
          {isCheckingUsage ? 'Checking' : 'Check now'}
        </button>
      </div>
      <div
        className="weekly-usage-gauge"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={weeklyUtilization === null ? undefined : Math.round(weeklyUtilization * 100)}
      >
        <div
          className="weekly-usage-gauge-fill"
          data-limit-reached={routingStatus.subscriptionWeeklyLimitReached}
          style={{ width: `${Math.min(weeklyUtilization ?? 0, 1) * 100}%` }}
        />
      </div>
      <div className="weekly-usage-details">
        <span>Auto mode switches to an API key when the subscription refuses a request for the weekly limit</span>
        <span>
          {weeklyResetsAt
            ? `Resets ${weeklyResetsAt.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
            : 'Reset time unknown'}
        </span>
      </div>
    </section>
  );
}

function describeRoutingReason(routingStatus: RoutingStatus): string {
  switch (routingStatus.routingMode) {
    case 'force_subscription':
      return 'Subscription only, set by hand';
    case 'force_api_key':
      return routingStatus.apiKeyRoutes.length === 0 ? 'API key only, but routes.yml has no API keys' : 'API key only, set by hand';
    case 'auto':
      if (!routingStatus.subscriptionWeeklyLimitReached) return 'Auto: the weekly limit has room';
      return routingStatus.apiKeyRoutes.length === 0 ? 'Auto: weekly limit reached, and routes.yml has no API keys' : 'Auto: weekly limit reached';
  }
}
