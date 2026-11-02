import os from 'node:os';
import path from 'node:path';
import { createClaudeProxyRelay, readClaudeProxyRelayConfiguration, type ClaudeProxyRelayConfiguration } from './claude_proxy_relay.ts';

const claudeProxyRelayPort = Number(process.env.CLAUDE_PROXY_RELAY_PORT ?? 4100);

const claudeProxyRelayDirectory = process.env.CLAUDE_PROXY_RELAY_DIRECTORY ?? path.join(os.homedir(), '.claude-proxy-relay');

let claudeProxyRelayConfiguration: ClaudeProxyRelayConfiguration;
try {
  claudeProxyRelayConfiguration = readClaudeProxyRelayConfiguration(claudeProxyRelayDirectory);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const claudeProxyRelay = createClaudeProxyRelay({
  centralUrl: claudeProxyRelayConfiguration.centralUrl,
  gatewayAuthToken: claudeProxyRelayConfiguration.gatewayAuthToken,
  relayDirectory: claudeProxyRelayDirectory,
  anthropicApiHost: 'api.anthropic.com',
  anthropicApiPort: 443,
  tunnelUpgradeTimeoutMilliseconds: 5000,
  certificateAuthorityDownloadRetryMilliseconds: 60_000,
});
claudeProxyRelay.httpServer.listen(claudeProxyRelayPort, '127.0.0.1', () => {
  console.log(`claude-proxy-relay listens on http://127.0.0.1:${claudeProxyRelayPort} and relays api.anthropic.com to ${claudeProxyRelayConfiguration.centralUrl.origin}`);
});

for (const signalName of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signalName, () => {
    void claudeProxyRelay.close().then(() => process.exit(0));
  });
}
