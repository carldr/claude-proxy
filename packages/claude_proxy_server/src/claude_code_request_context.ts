import type { IncomingHttpHeaders } from 'node:http';

export interface ClaudeCodeRequestContext {
  model: string | null;
  isStreaming: boolean;
  sessionId: string | null;
  projectPath: string | null;
  /** The text of the last user message, without `<system-reminder>` blocks. Empty when that message holds only tool results. */
  lastUserMessageText: string;
  /**
   * The tool results in the last user message: file contents, command output, search results.
   * Each tool result is the last user message of exactly one request, so indexing it there indexes it once.
   */
  lastUserMessageToolResultText: string;
}

const sessionIdPattern = /session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
const workingDirectoryPattern = /(?:Primary working directory|Working directory):\s*([^\s][^\n]*)/;
const systemReminderPattern = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Reads the model, session ID, project path and last user message from a Messages API request sent by Claude Code. */
export function extractClaudeCodeRequestContext(
  requestHeaders: IncomingHttpHeaders,
  requestBody: unknown,
): ClaudeCodeRequestContext {
  const requestFields = (typeof requestBody === 'object' && requestBody !== null ? requestBody : {}) as Record<string, unknown>;
  const messages = Array.isArray(requestFields.messages) ? (requestFields.messages as Array<Record<string, unknown>>) : [];
  return {
    model: typeof requestFields.model === 'string' ? requestFields.model : null,
    isStreaming: requestFields.stream === true,
    sessionId: extractSessionId(requestHeaders, requestFields.metadata),
    projectPath: extractProjectPath(requestFields.system, messages),
    lastUserMessageText: extractLastUserMessageText(messages),
    lastUserMessageToolResultText: extractLastUserMessageToolResultText(messages),
  };
}

function extractSessionId(requestHeaders: IncomingHttpHeaders, metadata: unknown): string | null {
  const sessionIdHeader = requestHeaders['x-claude-code-session-id'];
  if (typeof sessionIdHeader === 'string' && sessionIdHeader !== '') return sessionIdHeader;

  const userId = (metadata as { user_id?: unknown } | undefined)?.user_id;
  if (typeof userId !== 'string') return null;
  try {
    const userIdFields = JSON.parse(userId) as { session_id?: unknown };
    if (typeof userIdFields.session_id === 'string') return userIdFields.session_id;
  } catch {
    // Older Claude Code versions send "user_<hash>_account_<uuid>_session_<uuid>".
  }
  return sessionIdPattern.exec(userId)?.[1] ?? null;
}

/**
 * Finds the "Primary working directory" line of Claude Code's environment block. Claude Code puts that block
 * in the top-level `system` field or in an early `role: "system"` message, so the search stops at the first match.
 */
function extractProjectPath(system: unknown, messages: Array<Record<string, unknown>>): string | null {
  for (const content of [system, ...messages.map((message) => message.content)]) {
    const workingDirectory = workingDirectoryPattern.exec(readContentText(content))?.[1]?.trim();
    if (workingDirectory) return workingDirectory;
  }
  return null;
}

function extractLastUserMessageText(messages: Array<Record<string, unknown>>): string {
  const lastUserMessage = messages.findLast((message) => message.role === 'user');
  if (!lastUserMessage) return '';
  return readContentText(lastUserMessage.content).replace(systemReminderPattern, '').trim();
}

function extractLastUserMessageToolResultText(messages: Array<Record<string, unknown>>): string {
  const lastUserMessage = messages.findLast((message) => message.role === 'user');
  if (!lastUserMessage || !Array.isArray(lastUserMessage.content)) return '';
  return lastUserMessage.content
    .filter((contentBlock) => contentBlock?.type === 'tool_result')
    .map((toolResultBlock) => readContentText(toolResultBlock.content))
    .join('\n');
}

/** Joins the text of a string content or of the `text` blocks of a content-block list. */
function readContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((contentBlock) => contentBlock?.type === 'text' && typeof contentBlock.text === 'string')
    .map((contentBlock) => contentBlock.text as string)
    .join('\n');
}
