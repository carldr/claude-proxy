import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProjectNameRule, findProjectName } from '../src/project_name_rules.ts';

const projectNameRules = [
  buildProjectNameRule('/srv/roy/*/*/monorepo/@apps+{project_name}', null, 'rule'),
  buildProjectNameRule('/srv/roy/*/*/{project_name}/@', null, 'rule'),
  buildProjectNameRule('/Users/example_user/Development/monorepo/apps/{project_name}', null, 'rule'),
  buildProjectNameRule('/Users/example_user/Development/games/old-folder-name', 'new-name', 'rule'),
  buildProjectNameRule('/Users/example_user/Development/games/{project_name}', null, 'rule'),
];

for (const [projectPath, expectedProjectName] of [
  ['/srv/roy/github.com/example-org/some-game/@/worktrees/phase-3', 'some-game'],
  ['/srv/roy/github.com/example-org/monorepo/@apps+planet/worktrees/tiles/apps/planet/app/src', 'planet'],
  ['/Users/example_user/Development/games/some-game', 'some-game'],
  ['/Users/example_user/Development/games/some-game/tools/pacing', 'some-game'],
  ['/Users/example_user/Development/games/some-game/.claude/worktrees/agent-a27b', 'some-game'],
  ['/Users/example_user/Development/monorepo/.claude/worktrees/feature/apps/planet/app', 'planet'],
  ['/Users/example_user/Development/monorepo/apps/planet/.worktrees/feature/app', 'planet'],
  ['/Users/example_user/Development/games/old-folder-name/src', 'new-name'],
  ['/Users/example_user/Development/dotfiles', 'dotfiles'],
  ['/Users/example_user/Development/monorepo/.claude/worktrees/feature', 'monorepo'],
  ['/private/tmp', 'tmp'],
  ['/', '/'],
] as const) {
  test(`names ${projectPath} as ${expectedProjectName}`, () => {
    assert.equal(findProjectName(projectNameRules, projectPath), expectedProjectName);
  });
}

test('a rule wins over the name that the client sends, and the name that the client sends wins over the last directory', () => {
  assert.equal(findProjectName(projectNameRules, '/Users/example_user/Development/monorepo/apps/planet', 'monorepo'), 'planet');
  assert.equal(findProjectName(projectNameRules, '/Users/example_user/Development/folder-master', 'repository'), 'repository');
});

test('a request with no project path has the name that the client sends, or no name', () => {
  assert.equal(findProjectName(projectNameRules, null, 'repository'), 'repository');
  assert.equal(findProjectName(projectNameRules, null, null), null);
});

test('a star matches inside one directory only', () => {
  assert.equal(findProjectName(projectNameRules, '/srv/roy/github.com/a/b/some-game/@/worktrees/x'), 'x');
});

test('a pattern does not match a longer directory name', () => {
  assert.equal(findProjectName(projectNameRules, '/Users/example_user/Development/games/old-folder-name-2'), 'old-folder-name-2');
});

test('the first matching rule wins', () => {
  const overlappingRules = [
    buildProjectNameRule('/Users/example_user/{project_name}', null, 'rule'),
    buildProjectNameRule('/Users/example_user/Development', 'never', 'rule'),
  ];
  assert.equal(findProjectName(overlappingRules, '/Users/example_user/Development'), 'Development');
});

test('refuses a pattern that is not an absolute path', () => {
  assert.throws(() => buildProjectNameRule('~/Development/{project_name}', null, 'project_names[0]'), /project_names\[0\]\.project_path_pattern must be an absolute path/);
});

test('refuses a rule with no name, and a rule with two names', () => {
  assert.throws(() => buildProjectNameRule('/Users/example_user', null, 'project_names[0]'), /project_names\[0\] needs either/);
  assert.throws(() => buildProjectNameRule('/Users/{project_name}', 'name', 'project_names[0]'), /project_names\[0\] needs either/);
  assert.throws(() => buildProjectNameRule('/{project_name}/{project_name}', null, 'project_names[0]'), /project_names\[0\] needs either/);
});
