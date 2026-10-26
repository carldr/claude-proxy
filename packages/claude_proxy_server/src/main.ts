import os from 'node:os';
import path from 'node:path';
import { createClaudeProxyServer } from './claude_proxy_server.ts';
import { anthropicOAuthEndpoints } from './subscription_account_oauth.ts';
import { defaultClaudeCodeProjectsDirectory } from './web_api_handler.ts';

const claudeProxyPort = Number(process.env.CLAUDE_PROXY_PORT ?? 4100);

const claudeProxyServer = createClaudeProxyServer({
  claudeProxyDirectory: process.env.CLAUDE_PROXY_DIRECTORY ?? path.join(os.homedir(), '.claude-proxy'),
  anthropicBaseUrl: 'https://api.anthropic.com',
  oauthEndpoints: anthropicOAuthEndpoints,
  webUiDistDirectory: path.resolve(import.meta.dirname, '..', '..', 'claude_proxy_web_ui', 'dist'),
  claudeCodeProjectsDirectory: defaultClaudeCodeProjectsDirectory,
});
claudeProxyServer.httpServer.listen(claudeProxyPort, '127.0.0.1', () => {
  console.log(`claude-proxy listens on http://127.0.0.1:${claudeProxyPort}, web UI at http://127.0.0.1:${claudeProxyPort}/_proxy/`);
});

for (const signalName of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signalName, () => {
    void claudeProxyServer.close().then(() => process.exit(0));
  });
}
