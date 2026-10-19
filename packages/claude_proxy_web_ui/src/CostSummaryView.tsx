import { useEffect, useState } from 'react';
import { claudeProxyApi, type DailyRouteCost } from './claude_proxy_api.ts';
import { formatCostUsd, formatTokenCount } from './display_formatting.ts';
import { RouteDot, type RouteDotAppearance } from './RouteDot.tsx';

const dayCountOptions = [7, 30, 90, 365];

/** Estimated cost per day and route. Subscription costs are what the same requests would cost at API prices. */
export function CostSummaryView({ findRouteAppearance }: { findRouteAppearance: (routeName: string | null) => RouteDotAppearance }) {
  const [dayCount, setDayCount] = useState(30);
  const [dailyRouteCosts, setDailyRouteCosts] = useState<DailyRouteCost[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    claudeProxyApi.readCostSummary(dayCount).then(setDailyRouteCosts, (error: Error) => setLoadError(error.message));
  }, [dayCount]);

  const routeTotals = new Map<string, { requestCount: number; estimatedCostUsd: number; routeKind: string }>();
  for (const dailyRouteCost of dailyRouteCosts ?? []) {
    const routeTotal = routeTotals.get(dailyRouteCost.route_name) ?? { requestCount: 0, estimatedCostUsd: 0, routeKind: dailyRouteCost.route_kind };
    routeTotal.requestCount += dailyRouteCost.request_count;
    routeTotal.estimatedCostUsd += dailyRouteCost.estimated_cost_usd ?? 0;
    routeTotals.set(dailyRouteCost.route_name, routeTotal);
  }

  return (
    <div className="scrolling-view">
      <div className="view-toolbar">
        <select aria-label="Period" value={dayCount} onChange={(changeEvent) => setDayCount(Number(changeEvent.target.value))}>
          {dayCountOptions.map((dayCountOption) => (
            <option key={dayCountOption} value={dayCountOption}>
              Last {dayCountOption} days
            </option>
          ))}
        </select>
        <span className="muted">Subscription rows show what the same requests would cost at API prices from pricing.yml.</span>
      </div>
      {loadError && <p className="empty-state status-error">Costs did not load: {loadError}</p>}
      {dailyRouteCosts?.length === 0 && <p className="empty-state">No requests in this period.</p>}
      {dailyRouteCosts && dailyRouteCosts.length > 0 && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>Route</th>
                <th className="numeric">Requests</th>
                <th className="numeric">Estimated cost</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {[...routeTotals.entries()].map(([routeName, routeTotal]) => (
                <tr key={routeName}>
                  <td className="route-cell">
                    <RouteDot routeAppearance={findRouteAppearance(routeName)} />
                    {routeName}
                  </td>
                  <td className="numeric">{routeTotal.requestCount}</td>
                  <td className="numeric">{formatCostUsd(routeTotal.estimatedCostUsd)}</td>
                  <td className="muted">{routeTotal.routeKind === 'subscription' ? 'At API prices, not billed' : 'Billed to this key'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="data-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Route</th>
                <th className="numeric">Requests</th>
                <th className="numeric">Input</th>
                <th className="numeric">Cache read</th>
                <th className="numeric">Cache write</th>
                <th className="numeric">Output</th>
                <th className="numeric">Estimated cost</th>
              </tr>
            </thead>
            <tbody>
              {dailyRouteCosts.map((dailyRouteCost) => (
                <tr key={`${dailyRouteCost.day} ${dailyRouteCost.route_name}`}>
                  <td>{new Date(`${dailyRouteCost.day}T00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                  <td className="route-cell">
                    <RouteDot routeAppearance={findRouteAppearance(dailyRouteCost.route_name)} />
                    {dailyRouteCost.route_name}
                  </td>
                  <td className="numeric">{dailyRouteCost.request_count}</td>
                  <td className="numeric">{formatTokenCount(dailyRouteCost.input_tokens)}</td>
                  <td className="numeric">{formatTokenCount(dailyRouteCost.cache_read_input_tokens)}</td>
                  <td className="numeric">{formatTokenCount(dailyRouteCost.cache_creation_input_tokens)}</td>
                  <td className="numeric">{formatTokenCount(dailyRouteCost.output_tokens)}</td>
                  <td className="numeric">{formatCostUsd(dailyRouteCost.estimated_cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
