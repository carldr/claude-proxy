import { useState } from 'react';
import { claudeProxyApi, type ProxiedRequestDetail } from './claude_proxy_api.ts';
import { formatCostUsd, formatDuration, formatTokenCount } from './display_formatting.ts';
import { RequestStatus } from './ProxiedRequestsView.tsx';
import { RouteDot, type RouteDotAppearance } from './RouteDot.tsx';
import { usePolling } from './use_polling.ts';

interface ProxiedRequestDetailPanelProperties {
  proxiedRequestId: number;
  findRouteAppearance: (routeName: string | null) => RouteDotAppearance;
  onClose: () => void;
  onShowSession: (sessionId: string) => void;
}

/** Claude Code resends the whole conversation, so the panel opens only the last few messages of the request. */
const initiallyShownMessageCount = 4;

export function ProxiedRequestDetailPanel({ proxiedRequestId, findRouteAppearance, onClose, onShowSession }: ProxiedRequestDetailPanelProperties) {
  const [proxiedRequest, setProxiedRequest] = useState<ProxiedRequestDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Polls only while the request is still in progress.
  usePolling(
    () => {
      if (proxiedRequest?.id === proxiedRequestId && proxiedRequest.completed_at !== null) return;
      claudeProxyApi.readProxiedRequest(proxiedRequestId).then(
        (latestRequest) => {
          setProxiedRequest(latestRequest);
          setLoadError(null);
        },
        (error: Error) => setLoadError(error.message),
      );
    },
    3000,
    [proxiedRequestId],
  );

  if (loadError) return <aside className="request-detail status-error">Request {proxiedRequestId} did not load: {loadError}</aside>;
  if (!proxiedRequest || proxiedRequest.id !== proxiedRequestId) return <aside className="request-detail muted">Loading request {proxiedRequestId}</aside>;

  const requestBody = parseJsonOrNull(proxiedRequest.request_body) as Record<string, unknown> | null;
  const responseBody = parseJsonOrNull(proxiedRequest.response_body) as Record<string, unknown> | null;
  const requestMessages = Array.isArray(requestBody?.messages) ? (requestBody.messages as Array<Record<string, unknown>>) : [];
  const resumeCommand =
    proxiedRequest.session_id && proxiedRequest.project_path
      ? `cd ${quoteShellArgument(proxiedRequest.project_path)} && claude --resume ${proxiedRequest.session_id}`
      : null;

  return (
    <aside className="request-detail" aria-label={`Request ${proxiedRequest.id}`}>
      <div className="request-detail-heading">
        <h2>
          {proxiedRequest.http_method} {proxiedRequest.request_path}
        </h2>
        <button className="plain-button" onClick={onClose}>
          Close
        </button>
      </div>

      <dl className="request-facts">
        <dt>Started</dt>
        <dd>{new Date(proxiedRequest.started_at).toLocaleString()}</dd>
        <dt>Route</dt>
        <dd className="route-cell">
          <RouteDot routeAppearance={findRouteAppearance(proxiedRequest.route_name)} />
          {proxiedRequest.route_name ?? 'Not routed yet'}
        </dd>
        <dt>Status</dt>
        <dd>
          <RequestStatus proxiedRequest={proxiedRequest} />
          {proxiedRequest.stop_reason && <span className="muted"> stop reason {proxiedRequest.stop_reason}</span>}
        </dd>
        <dt>Model</dt>
        <dd>{proxiedRequest.model ?? ''}</dd>
        <dt>Tokens</dt>
        <dd>
          {formatTokenCount(proxiedRequest.input_tokens)} input, {formatTokenCount(proxiedRequest.cache_read_input_tokens)} cache read,{' '}
          {formatTokenCount((proxiedRequest.cache_creation_5m_input_tokens ?? 0) + (proxiedRequest.cache_creation_1h_input_tokens ?? 0))} cache write,{' '}
          {formatTokenCount(proxiedRequest.output_tokens)} output
        </dd>
        <dt>Estimated cost</dt>
        <dd>
          {formatCostUsd(proxiedRequest.estimated_cost_usd)}
          {proxiedRequest.route_kind === 'subscription' && <span className="muted"> at API prices, not billed</span>}
        </dd>
        <dt>Duration</dt>
        <dd>{formatDuration(proxiedRequest.duration_ms)}</dd>
        <dt>Project</dt>
        <dd>{proxiedRequest.project_path ?? ''}</dd>
        <dt>Session</dt>
        <dd>
          {proxiedRequest.session_id ? (
            <>
              <button className="text-button" onClick={() => onShowSession(proxiedRequest.session_id!)}>
                {proxiedRequest.session_id}
              </button>
              {resumeCommand && (
                <div>
                  <code className="resume-command">{resumeCommand}</code>{' '}
                  <button className="text-button" onClick={() => void navigator.clipboard.writeText(resumeCommand)}>
                    Copy
                  </button>
                </div>
              )}
            </>
          ) : (
            ''
          )}
        </dd>
      </dl>

      {proxiedRequest.upstream_attempts.length > 1 && (
        <>
          <h3>Upstream attempts</h3>
          <table className="data-table attempts-table">
            <thead>
              <tr>
                <th>Try</th>
                <th>Route</th>
                <th>Status</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {proxiedRequest.upstream_attempts.map((upstreamAttempt) => (
                <tr key={upstreamAttempt.attempt_number}>
                  <td>{upstreamAttempt.attempt_number}</td>
                  <td className="route-cell">
                    <RouteDot routeAppearance={findRouteAppearance(upstreamAttempt.route_name)} />
                    {upstreamAttempt.route_name}
                  </td>
                  <td>{upstreamAttempt.status_code ?? 'No response'}</td>
                  <td className="muted">{upstreamAttempt.error_body?.slice(0, 300) ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>Response</h3>
      {responseBody && Array.isArray(responseBody.content) ? (
        <ContentBlocks content={responseBody.content} />
      ) : (
        <pre className="code-block">{proxiedRequest.response_body ?? 'No response yet'}</pre>
      )}

      <h3>Request</h3>
      {requestBody?.system !== undefined && (
        <details>
          <summary>System prompt</summary>
          <ContentBlocks content={requestBody.system} />
        </details>
      )}
      <ConversationMessages messages={requestMessages} />

      <h3>Raw data</h3>
      <details>
        <summary>Request headers</summary>
        <pre className="code-block">{formatJson(proxiedRequest.request_headers_json)}</pre>
      </details>
      <details>
        <summary>Response headers</summary>
        <pre className="code-block">{formatJson(proxiedRequest.response_headers_json)}</pre>
      </details>
      <details>
        <summary>Request body</summary>
        <pre className="code-block">{formatJson(proxiedRequest.request_body)}</pre>
      </details>
      <details>
        <summary>Response body</summary>
        <pre className="code-block">{formatJson(proxiedRequest.response_body)}</pre>
      </details>
    </aside>
  );
}

function ConversationMessages({ messages }: { messages: Array<Record<string, unknown>> }) {
  const [isShowingAllMessages, setIsShowingAllMessages] = useState(false);
  const hiddenMessageCount = isShowingAllMessages ? 0 : Math.max(messages.length - initiallyShownMessageCount, 0);
  return (
    <>
      {hiddenMessageCount > 0 && (
        <p>
          <button className="plain-button" onClick={() => setIsShowingAllMessages(true)}>
            Show {hiddenMessageCount} earlier {hiddenMessageCount === 1 ? 'message' : 'messages'}
          </button>
        </p>
      )}
      {messages.slice(hiddenMessageCount).map((message, messageIndex) => (
        <div className="conversation-message" key={hiddenMessageCount + messageIndex}>
          <div className="conversation-message-role">{String(message.role)}</div>
          <ContentBlocks content={message.content} />
        </div>
      ))}
    </>
  );
}

/** Renders a Messages API content value: a string, or a list of text, thinking, tool_use and tool_result blocks. */
function ContentBlocks({ content }: { content: unknown }) {
  if (typeof content === 'string') return <div className="content-text">{content}</div>;
  if (!Array.isArray(content)) return <pre className="code-block">{JSON.stringify(content, null, 2)}</pre>;
  return (
    <>
      {content.map((contentBlock: Record<string, any>, blockIndex) => {
        switch (contentBlock?.type) {
          case 'text':
            return (
              <div className="content-text" key={blockIndex}>
                {contentBlock.text}
              </div>
            );
          case 'thinking':
            return (
              <details key={blockIndex}>
                <summary>Thinking</summary>
                <div className="content-text">{contentBlock.thinking || 'Not returned by the API'}</div>
              </details>
            );
          case 'tool_use':
            return (
              <details key={blockIndex} open>
                <summary>Tool call: {contentBlock.name}</summary>
                <pre className="code-block">{JSON.stringify(contentBlock.input, null, 2)}</pre>
              </details>
            );
          case 'tool_result':
            return (
              <details key={blockIndex}>
                <summary>Tool result{contentBlock.is_error ? ': error' : ''}</summary>
                <ContentBlocks content={contentBlock.content} />
              </details>
            );
          case 'image':
            return (
              <div className="muted" key={blockIndex}>
                Image
              </div>
            );
          default:
            return (
              <details key={blockIndex}>
                <summary>{String(contentBlock?.type ?? 'Unknown')} block</summary>
                <pre className="code-block">{JSON.stringify(contentBlock, null, 2)}</pre>
              </details>
            );
        }
      })}
    </>
  );
}

function parseJsonOrNull(jsonText: string | null): unknown {
  if (jsonText === null) return null;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function formatJson(jsonText: string | null): string {
  if (jsonText === null) return 'None';
  const parsedValue = parseJsonOrNull(jsonText);
  return parsedValue === null ? jsonText : JSON.stringify(parsedValue, null, 2);
}

function quoteShellArgument(shellArgument: string): string {
  return /^[\w./-]+$/.test(shellArgument) ? shellArgument : `'${shellArgument.replaceAll("'", "'\\''")}'`;
}
