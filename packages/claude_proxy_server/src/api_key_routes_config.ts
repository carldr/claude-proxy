export interface ApiKeyRoute {
  name: string;
  letter: string;
  colour: string;
  baseUrl: string;
  apiKey: string;
}

export const subscriptionRouteName = 'subscription';
export const subscriptionRouteLetter = 'S';
export const subscriptionRouteColour = '#ffffff';

/** Validates the parsed contents of `routes.yml` and converts them to `ApiKeyRoute` objects. */
export function parseApiKeyRoutesConfig(yamlValue: unknown): ApiKeyRoute[] {
  if (yamlValue === null || yamlValue === undefined) return [];
  const routeEntries = (yamlValue as { api_key_routes?: unknown }).api_key_routes;
  if (routeEntries === null || routeEntries === undefined) return [];
  if (!Array.isArray(routeEntries)) throw new Error('api_key_routes must be a list');

  const apiKeyRoutes = routeEntries.map((routeEntry: Record<string, unknown>, routeIndex): ApiKeyRoute => {
    const readRequiredString = (fieldName: string): string => {
      const fieldValue = routeEntry?.[fieldName];
      if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
        throw new Error(`api_key_routes[${routeIndex}].${fieldName} must be a non-empty string`);
      }
      return fieldValue.trim();
    };
    const apiKeyRoute: ApiKeyRoute = {
      name: readRequiredString('name'),
      letter: readRequiredString('letter'),
      colour: readRequiredString('colour'),
      baseUrl: readRequiredString('base_url').replace(/\/+$/, ''),
      apiKey: readRequiredString('api_key'),
    };
    if ([...apiKeyRoute.letter].length !== 1) {
      throw new Error(`api_key_routes[${routeIndex}].letter must be one character`);
    }
    if (apiKeyRoute.name === subscriptionRouteName) {
      throw new Error(`api_key_routes[${routeIndex}].name must not be "${subscriptionRouteName}"`);
    }
    return apiKeyRoute;
  });

  const routeNames = new Set<string>();
  for (const apiKeyRoute of apiKeyRoutes) {
    if (routeNames.has(apiKeyRoute.name)) throw new Error(`api_key_routes has two routes named "${apiKeyRoute.name}"`);
    routeNames.add(apiKeyRoute.name);
  }
  return apiKeyRoutes;
}
