import { useState } from 'react';
import {
  claudeProxyApi,
  type SubscriptionAccountStatus,
  type SubscriptionAccountStatusResponse,
  type SubscriptionAccountUsageWindow,
} from './claude_proxy_api.ts';
import { RouteDot } from './RouteDot.tsx';

interface SubscriptionAccountsPanelProperties {
  accountStatus: SubscriptionAccountStatusResponse | null;
  accountStatusError: string | null;
  onAccountStatusChange: (accountStatus: SubscriptionAccountStatusResponse) => void;
}

/** Shows one card per subscription account with its usage windows, its block state and its login buttons. */
export function SubscriptionAccountsPanel({ accountStatus, accountStatusError, onAccountStatusChange }: SubscriptionAccountsPanelProperties) {
  const [actionErrors, setActionErrors] = useState<string[]>([]);
  const [isCheckingUsage, setIsCheckingUsage] = useState(false);

  if (!accountStatus) {
    return (
      <header className="subscription-accounts-panel">
        <span className="muted">{accountStatusError ? `The proxy does not answer: ${accountStatusError}` : 'Loading subscription accounts'}</span>
      </header>
    );
  }

  const checkUsageNow = () => {
    setIsCheckingUsage(true);
    claudeProxyApi
      .checkSubscriptionAccountUsage()
      .then(
        (usageCheckResponse) => {
          onAccountStatusChange(usageCheckResponse);
          setActionErrors(usageCheckResponse.usageCheckErrors);
        },
        (error: Error) => setActionErrors([error.message]),
      )
      .finally(() => setIsCheckingUsage(false));
  };

  /** Opens the blank tab inside the click, so that a popup blocker allows it. The tab moves to the authorize URL when the server answers. */
  const openLogin = (subscriptionAccountName: string) => {
    const loginTab = window.open('about:blank', '_blank');
    claudeProxyApi.startSubscriptionAccountLogin(subscriptionAccountName).then(
      ({ authorizeUrl }) => {
        setActionErrors([]);
        if (loginTab) loginTab.location.href = authorizeUrl;
        else window.open(authorizeUrl, '_blank');
      },
      (error: Error) => {
        loginTab?.close();
        setActionErrors([error.message]);
      },
    );
  };

  const errorMessages = [...accountStatus.configErrors, ...(accountStatusError ? [accountStatusError] : []), ...actionErrors];

  return (
    <header className="subscription-accounts-panel">
      <div className="subscription-accounts-toolbar">
        <button onClick={checkUsageNow} disabled={isCheckingUsage}>
          {isCheckingUsage ? 'Checking' : 'Check usage now'}
        </button>
      </div>
      <div className="subscription-account-cards">
        {accountStatus.subscriptionAccounts.map((subscriptionAccount) => (
          <SubscriptionAccountCard
            key={subscriptionAccount.subscriptionAccountName}
            subscriptionAccount={subscriptionAccount}
            onLogin={openLogin}
          />
        ))}
      </div>
      {accountStatus.subscriptionAccounts.length === 0 && <span className="muted">No subscription accounts in the configuration</span>}
      {errorMessages.length > 0 && <p className="config-errors">{errorMessages.join('\n')}</p>}
    </header>
  );
}

function SubscriptionAccountCard({
  subscriptionAccount,
  onLogin,
}: {
  subscriptionAccount: SubscriptionAccountStatus;
  onLogin: (subscriptionAccountName: string) => void;
}) {
  const isLoginRequired = subscriptionAccount.loginState === 'login_required';
  return (
    <section className="subscription-account-card" aria-label={subscriptionAccount.subscriptionAccountName}>
      <div className="subscription-account-header">
        <RouteDot routeAppearance={{ colour: subscriptionAccount.colour }} size={18} />
        <span className="subscription-account-name">{subscriptionAccount.subscriptionAccountName}</span>
        {subscriptionAccount.emailAddress && <span className="muted">{subscriptionAccount.emailAddress}</span>}
      </div>
      {sortUsageWindows(subscriptionAccount.usageWindows).map((usageWindow) => (
        <UsageWindowBar key={usageWindow.usageWindowName} usageWindow={usageWindow} />
      ))}
      {subscriptionAccount.isBlocked && <div className="subscription-account-blocked">{describeBlock(subscriptionAccount.blockedUntil, subscriptionAccount.failoverUtilization)}</div>}
      <div className="subscription-account-actions">
        {isLoginRequired ? (
          <button onClick={() => onLogin(subscriptionAccount.subscriptionAccountName)}>Log in</button>
        ) : (
          <button className="text-button" onClick={() => onLogin(subscriptionAccount.subscriptionAccountName)}>
            Log in again
          </button>
        )}
      </div>
    </section>
  );
}

function UsageWindowBar({ usageWindow }: { usageWindow: SubscriptionAccountUsageWindow }) {
  const utilizationPercent = Math.round(usageWindow.utilization * 100);
  return (
    <div className="usage-window">
      <span>{usageWindow.usageWindowName}</span>
      <div
        className="usage-window-bar"
        role="meter"
        aria-label={`${usageWindow.usageWindowName} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={utilizationPercent}
      >
        <div
          className="usage-window-bar-fill"
          data-is-full={utilizationPercent >= 100}
          style={{ width: `${Math.min(Math.max(usageWindow.utilization, 0), 1) * 100}%` }}
        />
      </div>
      <span>{utilizationPercent}%</span>
      {usageWindow.resetsAt && <span className="usage-window-reset">resets in {formatTimeUntil(usageWindow.resetsAt)}</span>}
    </div>
  );
}

/** Orders the windows 5h, 7d, then the model windows in the order received. */
function sortUsageWindows(usageWindows: SubscriptionAccountUsageWindow[]): SubscriptionAccountUsageWindow[] {
  const windowRank = (usageWindow: SubscriptionAccountUsageWindow) =>
    usageWindow.usageWindowName === '5h' ? 0 : usageWindow.usageWindowName === '7d' ? 1 : 2;
  return [...usageWindows].sort((firstWindow, secondWindow) => windowRank(firstWindow) - windowRank(secondWindow));
}

function describeBlock(blockedUntil: string | null, failoverUtilization: number): string {
  if (blockedUntil === null) return `Avoided: at ${Math.round(failoverUtilization * 100)}% of a limit`;
  return `Rejected, retried last until ${new Date(blockedUntil).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

/** Formats the time until an ISO timestamp as "2h 47m", or "4d 21h" from 24 hours up. */
function formatTimeUntil(isoTimestamp: string): string {
  const totalMinutes = Math.max(0, Math.floor((new Date(isoTimestamp).getTime() - Date.now()) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
