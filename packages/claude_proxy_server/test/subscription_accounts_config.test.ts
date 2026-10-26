import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptySubscriptionAccountsConfig,
  findSubscriptionAccountNameForProject,
  parseSubscriptionAccountsConfig,
} from '../src/subscription_accounts_config.ts';

const homeDirectory = '/Users/example_user';

const exampleYaml = {
  subscription_accounts: [
    { name: 'Work', colour: '#a1c63d' },
    { name: 'Personal', colour: '#ba8048' },
  ],
  project_routes: [
    { project_path_pattern: '~/Development/client*', subscription_account: 'Work' },
    { project_path_pattern: '~/Development/work-dev', subscription_account: 'Work' },
  ],
  default_subscription_account: 'Personal',
};

test('parses accounts, routes and the default account, and expands ~', () => {
  const config = parseSubscriptionAccountsConfig(exampleYaml, homeDirectory);
  assert.equal(config.projectRoutes[0].projectPathPattern, '/Users/example_user/Development/client*');
  assert.deepEqual(config.subscriptionAccounts, [
    { name: 'Work', colour: '#a1c63d' },
    { name: 'Personal', colour: '#ba8048' },
  ]);
  assert.equal(config.defaultSubscriptionAccountName, 'Personal');
});

test('matches a pattern and every subdirectory of a match', () => {
  const config = parseSubscriptionAccountsConfig(exampleYaml, homeDirectory);
  assert.equal(findSubscriptionAccountNameForProject(config, '/Users/example_user/Development/client_project'), 'Work');
  assert.equal(findSubscriptionAccountNameForProject(config, '/Users/example_user/Development/client_project/src/deep'), 'Work');
  assert.equal(findSubscriptionAccountNameForProject(config, '/Users/example_user/Development/work-dev'), 'Work');
  assert.equal(findSubscriptionAccountNameForProject(config, '/Users/example_user/Development/work-dev-old'), 'Personal');
});

test('uses the first matching route', () => {
  const config = parseSubscriptionAccountsConfig(
    {
      ...exampleYaml,
      project_routes: [
        { project_path_pattern: '~/Development/*', subscription_account: 'Personal' },
        { project_path_pattern: '~/Development/client*', subscription_account: 'Work' },
      ],
    },
    homeDirectory,
  );
  assert.equal(findSubscriptionAccountNameForProject(config, '/Users/example_user/Development/client_x'), 'Personal');
});

test('gives the default account to an unmatched project and to a request with no project', () => {
  const config = parseSubscriptionAccountsConfig(exampleYaml, homeDirectory);
  assert.equal(findSubscriptionAccountNameForProject(config, '/tmp/other'), 'Personal');
  assert.equal(findSubscriptionAccountNameForProject(config, null), 'Personal');
});

test('rejects a route to an unknown account', () => {
  assert.throws(
    () =>
      parseSubscriptionAccountsConfig(
        { ...exampleYaml, project_routes: [{ project_path_pattern: '~/x', subscription_account: 'Nobody' }] },
        homeDirectory,
      ),
    /project_routes\[0\]\.subscription_account "Nobody" is not in subscription_accounts/,
  );
});

test('rejects a default account that is not listed', () => {
  assert.throws(
    () => parseSubscriptionAccountsConfig({ ...exampleYaml, default_subscription_account: 'Nobody' }, homeDirectory),
    /default_subscription_account "Nobody" is not in subscription_accounts/,
  );
});

test('rejects two accounts with one name', () => {
  assert.throws(
    () =>
      parseSubscriptionAccountsConfig(
        { subscription_accounts: [{ name: 'Work', colour: '#111111' }, { name: 'Work', colour: '#222222' }] },
        homeDirectory,
      ),
    /two accounts named "Work"/,
  );
});

test('rejects an account with an empty colour', () => {
  assert.throws(
    () => parseSubscriptionAccountsConfig({ subscription_accounts: [{ name: 'Work', colour: ' ' }] }, homeDirectory),
    /subscription_accounts\[0\]\.colour must be a non-empty string/,
  );
});

test('treats an empty file as no accounts', () => {
  assert.deepEqual(parseSubscriptionAccountsConfig(null, homeDirectory), emptySubscriptionAccountsConfig);
});

test('reads failover_utilization and defaults it to 0.98', () => {
  assert.equal(parseSubscriptionAccountsConfig(exampleYaml, homeDirectory).failoverUtilization, 0.98);
  assert.equal(parseSubscriptionAccountsConfig({ ...exampleYaml, failover_utilization: 0.9 }, homeDirectory).failoverUtilization, 0.9);
  assert.equal(parseSubscriptionAccountsConfig({ ...exampleYaml, failover_utilization: 1 }, homeDirectory).failoverUtilization, 1);
  assert.equal(emptySubscriptionAccountsConfig.failoverUtilization, 0.98);
  for (const invalidValue of [1.5, 0, -0.1, '0.9']) {
    assert.throws(
      () => parseSubscriptionAccountsConfig({ ...exampleYaml, failover_utilization: invalidValue }, homeDirectory),
      /failover_utilization must be a number above 0 and at most 1/,
    );
  }
});
