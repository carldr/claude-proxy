import { useEffect, useRef } from 'react';

/** Calls `poll` now and then every `intervalMs` while the page is visible. */
export function usePolling(poll: () => void, intervalMs: number, dependencies: unknown[]): void {
  const latestPoll = useRef(poll);
  latestPoll.current = poll;

  useEffect(() => {
    latestPoll.current();
    const pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') latestPoll.current();
    }, intervalMs);
    return () => clearInterval(pollTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
}
