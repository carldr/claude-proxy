import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import tls from 'node:tls';
import { createClaudeProxyServer, type ClaudeProxyServer } from '../src/claude_proxy_server.ts';

const createCertificateAuthorityScriptPath = path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'create_certificate_authority.sh');

describe('create_certificate_authority.sh', () => {
  let claudeProxyDirectory: string;

  beforeEach(() => {
    claudeProxyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proxy-certificate-authority-'));
  });

  afterEach(() => {
    fs.rmSync(claudeProxyDirectory, { recursive: true, force: true });
  });

  function runCreateCertificateAuthorityScript() {
    return spawnSync('sh', [createCertificateAuthorityScriptPath, claudeProxyDirectory], { encoding: 'utf8' });
  }

  function readClaudeProxyFile(fileName: string) {
    return fs.readFileSync(path.join(claudeProxyDirectory, fileName));
  }

  /** Connects a TLS client to a TLS server and returns the client's error, or null when the handshake succeeds. */
  async function connectTlsClient(serverCertificate: Buffer, serverKey: Buffer, serverName: string, trustedCertificate: Buffer) {
    const tlsServer = tls.createServer({ cert: serverCertificate, key: serverKey }, (serverSocket) => serverSocket.end());
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    try {
      return await new Promise<Error | null>((resolve) => {
        const clientSocket = tls.connect(
          { host: '127.0.0.1', port: (tlsServer.address() as AddressInfo).port, servername: serverName, ca: trustedCertificate },
          () => {
            clientSocket.destroy();
            resolve(null);
          },
        );
        clientSocket.on('error', (error) => {
          clientSocket.destroy();
          resolve(error);
        });
      });
    } finally {
      tlsServer.close();
    }
  }

  test('makes a CA whose certificate for api.anthropic.com a TLS client trusts', async () => {
    const scriptRun = runCreateCertificateAuthorityScript();
    assert.equal(scriptRun.status, 0, scriptRun.stderr);

    const clientError = await connectTlsClient(
      readClaudeProxyFile('api.anthropic.com.pem'),
      readClaudeProxyFile('api.anthropic.com-key.pem'),
      'api.anthropic.com',
      readClaudeProxyFile('certificate_authority.pem'),
    );

    assert.equal(clientError, null);
  });

  test('writes the keys with mode 600', () => {
    assert.equal(runCreateCertificateAuthorityScript().status, 0);
    for (const keyFileName of ['certificate_authority-key.pem', 'api.anthropic.com-key.pem']) {
      assert.equal(fs.statSync(path.join(claudeProxyDirectory, keyFileName)).mode & 0o777, 0o600, keyFileName);
    }
  });

  test('makes a CA that cannot sign another name', async () => {
    assert.equal(runCreateCertificateAuthorityScript().status, 0);
    const otherNameDirectory = path.join(claudeProxyDirectory, 'other_name');
    fs.mkdirSync(otherNameDirectory);
    const otherNamePath = (fileName: string) => path.join(otherNameDirectory, fileName);
    const caPath = (fileName: string) => path.join(claudeProxyDirectory, fileName);
    fs.writeFileSync(otherNamePath('extensions.cnf'), 'subjectAltName=DNS:example.com\nextendedKeyUsage=serverAuth\n');
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', otherNamePath('key.pem')]);
    execFileSync('openssl', ['req', '-new', '-key', otherNamePath('key.pem'), '-subj', '/CN=example.com', '-out', otherNamePath('request.pem')]);
    execFileSync('openssl', [
      'x509', '-req', '-in', otherNamePath('request.pem'), '-CA', caPath('certificate_authority.pem'),
      '-CAkey', caPath('certificate_authority-key.pem'), '-CAcreateserial', '-days', '1',
      '-extfile', otherNamePath('extensions.cnf'), '-out', otherNamePath('certificate.pem'),
    ], { stdio: 'ignore' });

    const clientError = await connectTlsClient(
      fs.readFileSync(otherNamePath('certificate.pem')),
      fs.readFileSync(otherNamePath('key.pem')),
      'example.com',
      readClaudeProxyFile('certificate_authority.pem'),
    );

    console.log(`name constraint error: code=${(clientError as NodeJS.ErrnoException | null)?.code} message=${clientError?.message}`);
    assert.ok(clientError, 'the client must reject the certificate');
    assert.match(`${(clientError as NodeJS.ErrnoException).code} ${clientError.message}`, /NAME_CONSTRAINT|permitted/);
  });

  test('refuses to replace an existing CA', () => {
    assert.equal(runCreateCertificateAuthorityScript().status, 0);
    const fileNames = ['certificate_authority.pem', 'certificate_authority-key.pem', 'api.anthropic.com.pem', 'api.anthropic.com-key.pem'];
    const filesBefore = fileNames.map(readClaudeProxyFile);

    const secondRun = runCreateCertificateAuthorityScript();

    assert.notEqual(secondRun.status, 0);
    assert.deepEqual(fileNames.map(readClaudeProxyFile), filesBefore);
  });

  describe('served by the proxy', () => {
    let claudeProxyServer: ClaudeProxyServer;

    afterEach(async () => {
      await claudeProxyServer.close();
    });

    async function fetchCertificateAuthority() {
      claudeProxyServer = createClaudeProxyServer({
        claudeProxyDirectory,
        anthropicBaseUrl: 'http://127.0.0.1:1',
        oauthEndpoints: { authorizeUrl: 'http://127.0.0.1:1/authorize', tokenUrl: 'http://127.0.0.1:1/token' },
        webUiDistDirectory: path.join(claudeProxyDirectory, 'no_web_ui'),
        publicHostname: null,
        gatewayAuthVerifyUrl: null,
      });
      await new Promise<void>((resolve) => claudeProxyServer.httpServer.listen(0, '127.0.0.1', resolve));
      const port = (claudeProxyServer.httpServer.address() as AddressInfo).port;
      return fetch(`http://127.0.0.1:${port}/_proxy/certificate_authority.pem`);
    }

    test('serves the CA certificate', async () => {
      assert.equal(runCreateCertificateAuthorityScript().status, 0);

      const response = await fetchCertificateAuthority();

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/x-pem-file');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), readClaudeProxyFile('certificate_authority.pem'));
    });

    test('answers 404 when the CA certificate is missing', async () => {
      assert.equal((await fetchCertificateAuthority()).status, 404);
    });
  });
});
