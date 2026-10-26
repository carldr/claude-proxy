import path from 'node:path';

export interface SubscriptionAccount {
  name: string;
  colour: string;
}

export interface ProjectRoute {
  projectPathPattern: string;
  subscriptionAccountName: string;
}

export interface SubscriptionAccountsConfig {
  subscriptionAccounts: SubscriptionAccount[];
  projectRoutes: ProjectRoute[];
  defaultSubscriptionAccountName: string | null;
}

export const emptySubscriptionAccountsConfig: SubscriptionAccountsConfig = {
  subscriptionAccounts: [],
  projectRoutes: [],
  defaultSubscriptionAccountName: null,
};

/** Validates the parsed contents of `subscription_accounts.yml`. A leading `~` in a pattern becomes `homeDirectory`. */
export function parseSubscriptionAccountsConfig(yamlValue: unknown, homeDirectory: string): SubscriptionAccountsConfig {
  if (yamlValue === null || yamlValue === undefined) return emptySubscriptionAccountsConfig;
  const yamlObject = yamlValue as {
    subscription_accounts?: unknown;
    project_routes?: unknown;
    default_subscription_account?: unknown;
  };

  const readEntries = (listName: string, listValue: unknown): Record<string, unknown>[] => {
    if (listValue === null || listValue === undefined) return [];
    if (!Array.isArray(listValue)) throw new Error(`${listName} must be a list`);
    return listValue;
  };
  const readRequiredString = (entry: Record<string, unknown>, entryPath: string, fieldName: string): string => {
    const fieldValue = entry?.[fieldName];
    if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
      throw new Error(`${entryPath}.${fieldName} must be a non-empty string`);
    }
    return fieldValue.trim();
  };

  const subscriptionAccounts = readEntries('subscription_accounts', yamlObject.subscription_accounts).map(
    (accountEntry, accountIndex): SubscriptionAccount => {
      const entryPath = `subscription_accounts[${accountIndex}]`;
      return {
        name: readRequiredString(accountEntry, entryPath, 'name'),
        colour: readRequiredString(accountEntry, entryPath, 'colour'),
      };
    },
  );
  const accountNames = new Set<string>();
  for (const subscriptionAccount of subscriptionAccounts) {
    if (accountNames.has(subscriptionAccount.name)) {
      throw new Error(`subscription_accounts has two accounts named "${subscriptionAccount.name}"`);
    }
    accountNames.add(subscriptionAccount.name);
  }

  const projectRoutes = readEntries('project_routes', yamlObject.project_routes).map(
    (routeEntry, routeIndex): ProjectRoute => {
      const entryPath = `project_routes[${routeIndex}]`;
      const projectPathPattern = readRequiredString(routeEntry, entryPath, 'project_path_pattern');
      const subscriptionAccountName = readRequiredString(routeEntry, entryPath, 'subscription_account');
      if (!accountNames.has(subscriptionAccountName)) {
        throw new Error(`${entryPath}.subscription_account "${subscriptionAccountName}" is not in subscription_accounts`);
      }
      return {
        projectPathPattern:
          projectPathPattern === '~' || projectPathPattern.startsWith('~/')
            ? homeDirectory + projectPathPattern.slice(1)
            : projectPathPattern,
        subscriptionAccountName,
      };
    },
  );

  let defaultSubscriptionAccountName: string | null = null;
  if (yamlObject.default_subscription_account !== null && yamlObject.default_subscription_account !== undefined) {
    const defaultValue = yamlObject.default_subscription_account;
    if (typeof defaultValue !== 'string' || defaultValue.trim() === '') {
      throw new Error('default_subscription_account must be a non-empty string');
    }
    defaultSubscriptionAccountName = defaultValue.trim();
    if (!accountNames.has(defaultSubscriptionAccountName)) {
      throw new Error(`default_subscription_account "${defaultSubscriptionAccountName}" is not in subscription_accounts`);
    }
  }

  return { subscriptionAccounts, projectRoutes, defaultSubscriptionAccountName };
}

/**
 * Returns the name of the subscription account for a project.
 * The first route whose pattern matches the project path or one of its parent directories wins.
 * Without a match, the function returns the default subscription account name.
 */
export function findSubscriptionAccountNameForProject(
  config: SubscriptionAccountsConfig,
  projectPath: string | null,
): string | null {
  if (projectPath !== null) {
    const projectAndParentPaths: string[] = [];
    for (let candidatePath = projectPath; ; candidatePath = path.dirname(candidatePath)) {
      projectAndParentPaths.push(candidatePath);
      if (path.dirname(candidatePath) === candidatePath) break;
    }
    for (const projectRoute of config.projectRoutes) {
      if (projectAndParentPaths.some((candidatePath) => path.matchesGlob(candidatePath, projectRoute.projectPathPattern))) {
        return projectRoute.subscriptionAccountName;
      }
    }
  }
  return config.defaultSubscriptionAccountName;
}
