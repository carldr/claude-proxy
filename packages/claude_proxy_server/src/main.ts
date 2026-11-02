import os from 'node:os';
import path from 'node:path';
import { assertListenAddressNeedsPublicHostname, createClaudeProxyServer } from './claude_proxy_server.ts';
import { anthropicOAuthEndpoints } from './subscription_account_oauth.ts';

const claudeProxyPort = Number(process.env.CLAUDE_PROXY_PORT ?? 4100);

const claudeProxyListenAddress = process.env.CLAUDE_PROXY_LISTEN_ADDRESS ?? '127.0.0.1';

assertListenAddressNeedsPublicHostname(claudeProxyListenAddress, process.env.CLAUDE_PROXY_PUBLIC_HOSTNAME || null);

const claudeProxyServer = createClaudeProxyServer({
  claudeProxyDirectory: process.env.CLAUDE_PROXY_DIRECTORY ?? path.join(os.homedir(), '.claude-proxy'),
  anthropicBaseUrl: 'https://api.anthropic.com',
  oauthEndpoints: anthropicOAuthEndpoints,
  webUiDistDirectory: path.resolve(import.meta.dirname, '..', '..', 'claude_proxy_web_ui', 'dist'),
  publicHostname: process.env.CLAUDE_PROXY_PUBLIC_HOSTNAME || null,
  gatewayAuthVerifyUrl: process.env.CLAUDE_PROXY_GATEWAY_AUTH_VERIFY_URL ? new URL(process.env.CLAUDE_PROXY_GATEWAY_AUTH_VERIFY_URL) : null,
});
claudeProxyServer.httpServer.listen(claudeProxyPort, claudeProxyListenAddress, () => {
  console.log(`claude-proxy listens on http://${claudeProxyListenAddress}:${claudeProxyPort}, web UI at http://${claudeProxyListenAddress}:${claudeProxyPort}/_proxy/`);
});
claudeProxyServer.subscriptionAccountUsageMonitor.start();
void claudeProxyServer.subscriptionAccountUsageMonitor.checkAllSubscriptionAccountUsage().then((usageCheckErrors) => {
  for (const usageCheckError of usageCheckErrors) console.error(`claude-proxy usage check failed for ${usageCheckError}`);
});

for (const signalName of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signalName, () => {
    void claudeProxyServer.close().then(() => process.exit(0));
  });
}
