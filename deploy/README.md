# Run claude-proxy as a central service

This directory runs claude-proxy on docker-host, in the same layout as another app. The proxy listens on port 4100 and serves `claude-proxy.example.com`.

## Requirements

- Access to docker-builder, which builds the image and keeps the registry.
- Access to docker-host, which runs the container.
- The Gateway Auth `/verify` URL with its `team_id`.

## Build and push the image

Run these commands on your machine, in a checkout where the commit is pushed to GitHub. The build needs the full commit hash, because BuildKit does not resolve a short hash. The tag is the short hash.

```sh
commit=$(git rev-parse HEAD)
docker --host ssh://docker-builder build -t localhost:5000/claude-proxy:${commit:0:7} https://github.com/carldr/claude-proxy.git#$commit
docker --host ssh://docker-builder push localhost:5000/claude-proxy:${commit:0:7}
```

## Run the service

1. Copy `docker-compose.yml` to `/root/claude-proxy` on docker-host. Make the data directory: `mkdir /root/claude-proxy/data && chown 1000:1000 /root/claude-proxy/data && chmod 700 /root/claude-proxy/data`.
2. Make `/root/claude-proxy/.env` with these two lines. Replace `<commit>` and the verify URL.

   ```sh
   CLAUDE_PROXY_IMAGE=registry.example.com:5000/claude-proxy:<commit>
   CLAUDE_PROXY_GATEWAY_AUTH_VERIFY_URL=<Gateway Auth /verify URL with team_id>
   ```

3. Start the service from `/root/claude-proxy`.

   ```sh
   docker compose up -d
   ```

The proxy does not start without `CLAUDE_PROXY_GATEWAY_AUTH_VERIFY_URL`, because it has a public hostname.

## Make the certificate authority

Run this command once, after the first start. The script refuses to replace an existing certificate authority.

```sh
docker compose exec claude_proxy sh scripts/create_certificate_authority.sh /data
```

Each machine that runs Claude Code trusts `/data/certificate_authority.pem`, or downloads it from `/_proxy/certificate_authority.pem`.

## Add the Moss proxy

Run these commands once. They send `claude-proxy.example.com` to port 4100 on docker-host, behind Gateway Auth. Replace the team ID with the ID of the team `gateway-auth-claude-proxy`.

```sh
moss proxy add --domain claude-proxy.example.com --vm-name docker-host --target-port 4100 --proxy-mode none --create-dns-cname-record
moss proxy set-gateway-auth-team-id --domain claude-proxy.example.com --gateway-auth-team-id <team ID>
```

`--proxy-mode none` is required. Cloudflare does not carry `Upgrade: claude-proxy-tunnel`, so with Cloudflare every tunnel would fall back to a direct connection with no error.

Make a Gateway Auth token for each machine in your gateway-auth-repository checkout. The command prints the token once.

```sh
pnpm --silent --filter gateway-auth tokens add gateway-auth-claude-proxy <machine name>
```

## Update the service

1. Build and push the new commit.
2. Change `CLAUDE_PROXY_IMAGE` in `.env` to the new tag.
3. Run `docker compose up -d` in `/root/claude-proxy`.

`/root/claude-proxy/data` on docker-host is `/data` in the container. It holds the database, the grants of the subscription accounts and the certificates. It must be owned by UID 1000, the user `node`, with mode 700.

## Files

| File | Contents |
| --- | --- |
| `docker-compose.yml` | The `claude_proxy` service, its volume, its port and its healthcheck. |
| `../Dockerfile` | The image. It runs as the user `node`, with `/data` as the proxy directory. |
