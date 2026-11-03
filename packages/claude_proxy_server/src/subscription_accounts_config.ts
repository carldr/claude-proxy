import path from 'node:path';
import { buildProjectNameRule, type ProjectNameRule } from './project_name_rules.ts';

export interface SubscriptionAccount {
  name: string;
  colour: string;
  /**
   * The proxy avoids this subscription account at or above this utilization of its 5-hour or weekly window.
   * The default is 1, so the proxy uses the account until the account rejects a request.
   */
  failoverUtilization: number;
}

export interface ProjectRoute {
  projectPathPattern: string;
  subscriptionAccountName: string;
}

export interface SubscriptionAccountsConfig {
  subscriptionAccounts: SubscriptionAccount[];
  projectRoutes: ProjectRoute[];
  defaultSubscriptionAccountName: string | null;
  projectNameRules: ProjectNameRule[];
}

const defaultFailoverUtilization = 1;

export const emptySubscriptionAccountsConfig: SubscriptionAccountsConfig = {
  subscriptionAccounts: [],
  projectRoutes: [],
  defaultSubscriptionAccountName: null,
  projectNameRules: [],
};

/** Validates the parsed contents of `subscription_accounts.yml`. Each project route pattern must be an absolute path. */
export function parseSubscriptionAccountsConfig(yamlValue: unknown): SubscriptionAccountsConfig {
  if (yamlValue === null || yamlValue === undefined) return emptySubscriptionAccountsConfig;
  const yamlObject = yamlValue as {
    subscription_accounts?: unknown;
    project_routes?: unknown;
    default_subscription_account?: unknown;
    failover_utilization?: unknown;
    project_names?: unknown;
  };

  if (yamlObject.failover_utilization !== undefined) {
    throw new Error(
      'failover_utilization is no longer a top-level key. Move it onto each entry of subscription_accounts that needs it',
    );
  }

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
      const failoverUtilizationValue = accountEntry?.failover_utilization;
      if (
        failoverUtilizationValue !== null &&
        failoverUtilizationValue !== undefined &&
        (typeof failoverUtilizationValue !== 'number' || !(failoverUtilizationValue > 0 && failoverUtilizationValue <= 1))
      ) {
        throw new Error(`${entryPath}.failover_utilization must be a number above 0 and at most 1`);
      }
      return {
        name: readRequiredString(accountEntry, entryPath, 'name'),
        colour: readRequiredString(accountEntry, entryPath, 'colour'),
        failoverUtilization: typeof failoverUtilizationValue === 'number' ? failoverUtilizationValue : defaultFailoverUtilization,
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
      if (!projectPathPattern.startsWith('/')) {
        throw new Error(`${entryPath}.project_path_pattern must be an absolute path that starts with "/"`);
      }
      return { projectPathPattern, subscriptionAccountName };
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

  const projectNameRules = readEntries('project_names', yamlObject.project_names).map((ruleEntry, ruleIndex) => {
    const entryPath = `project_names[${ruleIndex}]`;
    const projectName = ruleEntry?.project_name === undefined ? null : readRequiredString(ruleEntry, entryPath, 'project_name');
    return buildProjectNameRule(readRequiredString(ruleEntry, entryPath, 'project_path_pattern'), projectName, entryPath);
  });

  return { subscriptionAccounts, projectRoutes, defaultSubscriptionAccountName, projectNameRules };
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
