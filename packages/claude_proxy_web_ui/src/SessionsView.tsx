import { useEffect, useState } from 'react';
import { claudeProxyApi, type ClaudeCodeSession } from './claude_proxy_api.ts';
import { formatCostUsd, formatTimestamp } from './display_formatting.ts';

/** Lists Claude Code sessions, so a past conversation can be found by project and by its first prompt. */
export function SessionsView({ onShowSessionRequests }: { onShowSessionRequests: (sessionId: string) => void }) {
  const [projectName, setProjectName] = useState('');
  const [projectNames, setProjectNames] = useState<string[]>([]);
  const [sessions, setSessions] = useState<ClaudeCodeSession[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void claudeProxyApi.readRequestFilterOptions().then((filterOptions) => setProjectNames(filterOptions.projectNames), () => undefined);
  }, []);

  useEffect(() => {
    claudeProxyApi.listSessions(projectName).then(setSessions, (error: Error) => setLoadError(error.message));
  }, [projectName]);

  return (
    <div className="scrolling-view">
      <div className="view-toolbar">
        <select aria-label="Project" value={projectName} onChange={(changeEvent) => setProjectName(changeEvent.target.value)}>
          <option value="">All projects</option>
          {projectNames.map((candidateName) => (
            <option key={candidateName}>{candidateName}</option>
          ))}
        </select>
        <span className="muted">Select a session to see its requests. Use the Requests search to find text inside sessions.</span>
      </div>
      {loadError && <p className="empty-state status-error">Sessions did not load: {loadError}</p>}
      {sessions?.length === 0 && <p className="empty-state">No Claude Code sessions have passed through the proxy yet.</p>}
      {sessions && sessions.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Last activity</th>
              <th>Project</th>
              <th>First prompt</th>
              <th className="numeric">Requests</th>
              <th className="numeric">Cost</th>
              <th>Resume</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.session_id} data-clickable="true" tabIndex={0} onClick={() => onShowSessionRequests(session.session_id)}
                onKeyDown={(keyEvent) => keyEvent.key === 'Enter' && onShowSessionRequests(session.session_id)}>
                <td>{formatTimestamp(session.last_started_at)}</td>
                <td className="project-name" title={session.project_path ?? ''}>{session.project_name}</td>
                <td className="prompt-preview" title={session.first_user_text ?? ''}>
                  {session.first_user_text}
                </td>
                <td className="numeric">{session.request_count}</td>
                <td className="numeric">{formatCostUsd(session.estimated_cost_usd)}</td>
                <td>
                  <code className="resume-command">claude --resume {session.session_id.slice(0, 8)}</code>{' '}
                  <button
                    className="text-button"
                    onClick={(clickEvent) => {
                      clickEvent.stopPropagation();
                      void navigator.clipboard.writeText(
                        session.project_path ? `cd '${session.project_path}' && claude --resume ${session.session_id}` : `claude --resume ${session.session_id}`,
                      );
                    }}
                  >
                    Copy
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
