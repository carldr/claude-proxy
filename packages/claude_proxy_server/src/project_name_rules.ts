import path from 'node:path';

export interface ProjectNameRule {
  projectPathMatcher: RegExp;
  /** Null when the pattern holds `{project_name}`. The matching directory is then the name. */
  projectName: string | null;
}

const projectNamePlaceholder = '{project_name}';

/** A worktree directory says which checkout a session used, not which project. */
const worktreeDirectoryPattern = /\/(?:\.claude\/worktrees|\.worktrees)\/[^/]+/;

function translatePatternTextToRegularExpression(patternText: string): string {
  return patternText.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
}

/**
 * Builds one entry of `project_names`. In the pattern, `*` matches inside one directory, and `{project_name}` matches
 * one directory and names the project. The pattern also matches every subdirectory of a match.
 */
export function buildProjectNameRule(projectPathPattern: string, projectName: string | null, entryPath: string): ProjectNameRule {
  if (!projectPathPattern.startsWith('/')) {
    throw new Error(`${entryPath}.project_path_pattern must be an absolute path that starts with "/"`);
  }
  const patternTexts = projectPathPattern.split(projectNamePlaceholder);
  const placeholderCount = patternTexts.length - 1;
  if (placeholderCount + (projectName === null ? 0 : 1) !== 1) {
    throw new Error(`${entryPath} needs either one ${projectNamePlaceholder} in project_path_pattern or a project_name`);
  }
  const translatedPattern = patternTexts.map(translatePatternTextToRegularExpression).join('([^/]+)');
  return { projectPathMatcher: new RegExp(`^${translatedPattern}(?:/.*)?$`), projectName };
}

/**
 * Returns the name of the project of a request. The worktree directory does not count. The first matching rule wins,
 * because a rule can name the part of a repository that a client cannot. Without a match, the name is
 * `clientProjectName`, the value of the `X-Claude-Proxy-Project` header. Without a header, it is the last directory of the path.
 */
export function findProjectName(
  projectNameRules: ProjectNameRule[],
  projectPath: string | null,
  clientProjectName: string | null = null,
): string | null {
  if (projectPath === null) return clientProjectName;
  const pathWithoutWorktree = projectPath.replace(worktreeDirectoryPattern, '');
  for (const projectNameRule of projectNameRules) {
    const pathMatch = projectNameRule.projectPathMatcher.exec(pathWithoutWorktree);
    if (pathMatch) return projectNameRule.projectName ?? pathMatch[1]!;
  }
  return clientProjectName ?? (path.basename(pathWithoutWorktree) || pathWithoutWorktree);
}
