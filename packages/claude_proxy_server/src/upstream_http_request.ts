import http, { type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';

/**
 * Sends one HTTP request and resolves when the response headers arrive.
 * It uses `node:http` rather than `fetch`, because `fetch` stops a response that sends no headers for 300 seconds,
 * and a long non-streaming Messages API request can take longer than that.
 */
export function sendUpstreamHttpRequest(
  upstreamUrl: URL,
  httpMethod: string,
  upstreamHeaders: OutgoingHttpHeaders,
  requestBody: Buffer,
  abortSignal: AbortSignal,
): Promise<IncomingMessage> {
  const sendRequest = upstreamUrl.protocol === 'https:' ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const upstreamRequest = sendRequest(upstreamUrl, { method: httpMethod, headers: upstreamHeaders, signal: abortSignal }, resolve);
    upstreamRequest.on('error', reject);
    upstreamRequest.end(requestBody.length > 0 ? requestBody : undefined);
  });
}

export async function readIncomingBody(incomingMessage: IncomingMessage): Promise<Buffer> {
  const bodyChunks: Buffer[] = [];
  for await (const bodyChunk of incomingMessage) bodyChunks.push(bodyChunk as Buffer);
  return Buffer.concat(bodyChunks);
}
