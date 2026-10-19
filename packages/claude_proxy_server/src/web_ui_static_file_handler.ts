import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const webUiPathPrefix = '/_proxy/';

const contentTypesByExtension: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

/** Serves the built web UI from `packages/claude_proxy_web_ui/dist` under `/_proxy/`. Unknown paths get `index.html`. */
export function handleWebUiStaticFileRequest(
  clientRequest: IncomingMessage,
  clientResponse: ServerResponse,
  webUiDistDirectory: string,
): void {
  const requestPath = decodeURIComponent(new URL(clientRequest.url ?? '/', 'http://claude-proxy').pathname);
  const relativeFilePath = requestPath.slice(webUiPathPrefix.length) || 'index.html';
  let filePath = path.resolve(webUiDistDirectory, relativeFilePath);
  if (!filePath.startsWith(webUiDistDirectory + path.sep) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(webUiDistDirectory, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    clientResponse.writeHead(503, { 'content-type': 'text/plain' });
    clientResponse.end('The web UI is not built. Run "pnpm build" in the claude-proxy repository.');
    return;
  }
  clientResponse.writeHead(200, {
    'content-type': contentTypesByExtension[path.extname(filePath)] ?? 'application/octet-stream',
    'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(filePath).pipe(clientResponse);
}
