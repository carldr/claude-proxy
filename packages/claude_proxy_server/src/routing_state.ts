import {
  subscriptionRouteColour,
  subscriptionRouteLetter,
  subscriptionRouteName,
  type ApiKeyRoute,
} from './api_key_routes_config.ts';
import type { RequestDatabase } from './request_database.ts';
import type { SubscriptionWeeklyRateLimit } from './subscription_rate_limit_headers.ts';

export type RoutingMode = 'auto' | 'force_subscription' | 'force_api_key';
export const routingModes: RoutingMode[] = ['auto', 'force_subscription', 'force_api_key'];

/** In auto mode, the proxy moves subscription traffic to API keys at this fraction of the weekly limit. */
export const subscriptionWeeklyUtilizationSwitchThreshold = 0.98;

export type UpstreamRoute = { routeKind: 'subscription' } | { routeKind: 'api_key'; apiKeyRoute: ApiKeyRoute };

export interface RouteAppearance {
  routeKind: 'subscription' | 'api_key';
  routeName: string;
  letter: string;
  colour: string;
}

const settingNames = {
  routingMode: 'routing_mode',
  selectedApiKeyRouteName: 'selected_api_key_route_name',
  subscriptionWeeklyUtilization: 'subscription_weekly_utilization',
  subscriptionWeeklyResetsAt: 'subscription_weekly_resets_at',
  subscriptionWeeklyLimitReached: 'subscription_weekly_limit_reached',
  subscriptionUsageCheckedAt: 'subscription_usage_checked_at',
} as const;

/**
 * Holds the routing mode, the selected API key route and the last known weekly subscription usage.
 * All of it is stored in the `proxy_settings` table, so it survives a restart.
 */
export class RoutingState {
  private readonly requestDatabase: RequestDatabase;
  private readonly readApiKeyRoutes: () => ApiKeyRoute[];

  constructor(requestDatabase: RequestDatabase, readApiKeyRoutes: () => ApiKeyRoute[]) {
    this.requestDatabase = requestDatabase;
    this.readApiKeyRoutes = readApiKeyRoutes;
  }

  get routingMode(): RoutingMode {
    const storedRoutingMode = this.requestDatabase.readSetting(settingNames.routingMode) as RoutingMode | null;
    return storedRoutingMode && routingModes.includes(storedRoutingMode) ? storedRoutingMode : 'auto';
  }

  setRoutingMode(routingMode: RoutingMode): void {
    if (!routingModes.includes(routingMode)) throw new Error(`Unknown routing mode "${routingMode}"`);
    this.requestDatabase.writeSetting(settingNames.routingMode, routingMode);
  }

  get selectedApiKeyRouteName(): string | null {
    return this.requestDatabase.readSetting(settingNames.selectedApiKeyRouteName);
  }

  setSelectedApiKeyRouteName(apiKeyRouteName: string): void {
    if (!this.readApiKeyRoutes().some((apiKeyRoute) => apiKeyRoute.name === apiKeyRouteName)) {
      throw new Error(`No API key route is named "${apiKeyRouteName}"`);
    }
    this.requestDatabase.writeSetting(settingNames.selectedApiKeyRouteName, apiKeyRouteName);
  }

  /** Records the weekly usage that a subscription response reported in its rate limit headers. */
  recordSubscriptionWeeklyRateLimit(weeklyRateLimit: SubscriptionWeeklyRateLimit): void {
    if (weeklyRateLimit.weeklyUtilization === null && !weeklyRateLimit.isWeeklyLimitRejection) return;
    if (weeklyRateLimit.weeklyUtilization !== null) {
      this.requestDatabase.writeSetting(settingNames.subscriptionWeeklyUtilization, String(weeklyRateLimit.weeklyUtilization));
    }
    if (weeklyRateLimit.weeklyResetsAt !== null) {
      this.requestDatabase.writeSetting(settingNames.subscriptionWeeklyResetsAt, weeklyRateLimit.weeklyResetsAt.toISOString());
    }
    const isWeeklyLimitReached =
      weeklyRateLimit.isWeeklyLimitRejection ||
      (weeklyRateLimit.weeklyUtilization ?? 0) >= subscriptionWeeklyUtilizationSwitchThreshold;
    this.requestDatabase.writeSetting(settingNames.subscriptionWeeklyLimitReached, String(isWeeklyLimitReached));
    this.requestDatabase.writeSetting(settingNames.subscriptionUsageCheckedAt, new Date().toISOString());
  }

  /** Records the weekly usage that the subscription usage endpoint reported. */
  recordSubscriptionUsageCheck(weeklyUtilization: number, weeklyResetsAt: Date | null): void {
    this.recordSubscriptionWeeklyRateLimit({ weeklyUtilization, weeklyResetsAt, isWeeklyLimitRejection: false });
  }

  /** True when the weekly limit was reached and its reset time, if known, has not passed. */
  isSubscriptionWeeklyLimitReached(now = new Date()): boolean {
    if (this.requestDatabase.readSetting(settingNames.subscriptionWeeklyLimitReached) !== 'true') return false;
    const weeklyResetsAt = this.subscriptionWeeklyResetsAt;
    if (weeklyResetsAt !== null && now >= weeklyResetsAt) {
      this.requestDatabase.writeSetting(settingNames.subscriptionWeeklyLimitReached, 'false');
      this.requestDatabase.writeSetting(settingNames.subscriptionWeeklyUtilization, null);
      return false;
    }
    return true;
  }

  get subscriptionWeeklyResetsAt(): Date | null {
    const weeklyResetsAtText = this.requestDatabase.readSetting(settingNames.subscriptionWeeklyResetsAt);
    return weeklyResetsAtText === null ? null : new Date(weeklyResetsAtText);
  }

  /** The API key routes in the order to try them: the selected route first, then the rest in `routes.yml` order. */
  orderedApiKeyRoutes(): ApiKeyRoute[] {
    const apiKeyRoutes = this.readApiKeyRoutes();
    const selectedRouteIndex = apiKeyRoutes.findIndex((apiKeyRoute) => apiKeyRoute.name === this.selectedApiKeyRouteName);
    if (selectedRouteIndex <= 0) return apiKeyRoutes;
    return [...apiKeyRoutes.slice(selectedRouteIndex), ...apiKeyRoutes.slice(0, selectedRouteIndex)];
  }

  /**
   * The upstream routes for one subscription request, in the order to try them.
   * In auto mode the subscription comes last when its weekly limit is reached, because it may still have a little capacity.
   */
  planUpstreamRoutes(): UpstreamRoute[] {
    const subscriptionRoute: UpstreamRoute = { routeKind: 'subscription' };
    const apiKeyRoutes: UpstreamRoute[] = this.orderedApiKeyRoutes().map((apiKeyRoute) => ({ routeKind: 'api_key', apiKeyRoute }));
    switch (this.routingMode) {
      case 'force_subscription':
        return [subscriptionRoute];
      case 'force_api_key':
        return apiKeyRoutes.length > 0 ? apiKeyRoutes : [subscriptionRoute];
      case 'auto':
        return this.isSubscriptionWeeklyLimitReached() ? [...apiKeyRoutes, subscriptionRoute] : [subscriptionRoute, ...apiKeyRoutes];
    }
  }

  /** The route that the next subscription request goes to first. */
  activeRouteAppearance(): RouteAppearance {
    const firstUpstreamRoute = this.planUpstreamRoutes()[0]!;
    return describeUpstreamRoute(firstUpstreamRoute);
  }

  readRoutingStatus() {
    const weeklyUtilizationText = this.requestDatabase.readSetting(settingNames.subscriptionWeeklyUtilization);
    return {
      routingMode: this.routingMode,
      selectedApiKeyRouteName: this.selectedApiKeyRouteName,
      activeRoute: this.activeRouteAppearance(),
      subscriptionWeeklyLimitReached: this.isSubscriptionWeeklyLimitReached(),
      subscriptionWeeklyUtilization: weeklyUtilizationText === null ? null : Number(weeklyUtilizationText),
      subscriptionWeeklyResetsAt: this.subscriptionWeeklyResetsAt?.toISOString() ?? null,
      subscriptionUsageCheckedAt: this.requestDatabase.readSetting(settingNames.subscriptionUsageCheckedAt),
      subscriptionWeeklyUtilizationSwitchThreshold,
      apiKeyRoutes: this.readApiKeyRoutes().map((apiKeyRoute) => ({
        routeName: apiKeyRoute.name,
        letter: apiKeyRoute.letter,
        colour: apiKeyRoute.colour,
        baseUrl: apiKeyRoute.baseUrl,
      })),
    };
  }
}

export function describeUpstreamRoute(upstreamRoute: UpstreamRoute): RouteAppearance {
  if (upstreamRoute.routeKind === 'subscription') {
    return { routeKind: 'subscription', routeName: subscriptionRouteName, letter: subscriptionRouteLetter, colour: subscriptionRouteColour };
  }
  return {
    routeKind: 'api_key',
    routeName: upstreamRoute.apiKeyRoute.name,
    letter: upstreamRoute.apiKeyRoute.letter,
    colour: upstreamRoute.apiKeyRoute.colour,
  };
}
