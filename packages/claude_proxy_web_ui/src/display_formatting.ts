export function formatTimestamp(isoTimestamp: string | null): string {
  if (!isoTimestamp) return '';
  const timestamp = new Date(isoTimestamp);
  const isToday = timestamp.toDateString() === new Date().toDateString();
  return isToday
    ? timestamp.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : timestamp.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatTokenCount(tokenCount: number | null | undefined): string {
  if (tokenCount === null || tokenCount === undefined) return '';
  if (tokenCount >= 1_000_000) return `${(tokenCount / 1_000_000).toFixed(1)}M`;
  if (tokenCount >= 10_000) return `${Math.round(tokenCount / 1000)}k`;
  if (tokenCount >= 1000) return `${(tokenCount / 1000).toFixed(1)}k`;
  return String(tokenCount);
}

export function formatCostUsd(costUsd: number | null | undefined): string {
  if (costUsd === null || costUsd === undefined) return '';
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(2)}`;
}

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '';
  if (durationMs < 1000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`;
  return `${Math.floor(durationMs / 60_000)} min ${Math.round((durationMs % 60_000) / 1000)} s`;
}

/** Shows the last two directories of a project path, which is usually enough to tell projects apart. */
export function shortenProjectPath(projectPath: string | null): string {
  if (!projectPath) return '';
  return projectPath.split('/').filter(Boolean).slice(-2).join('/');
}

export function totalInputTokens(request: {
  input_tokens: number | null;
  cache_creation_5m_input_tokens: number | null;
  cache_creation_1h_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}): number | null {
  if (request.input_tokens === null) return null;
  return (
    request.input_tokens +
    (request.cache_creation_5m_input_tokens ?? 0) +
    (request.cache_creation_1h_input_tokens ?? 0) +
    (request.cache_read_input_tokens ?? 0)
  );
}
