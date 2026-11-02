# Run claude-proxy as a central service

This directory runs claude-proxy on docker-host, in the same layout as another app. The proxy listens on port 4100 and serves `claude-proxy.example.com`.

## Requirements

- Access to docker-builder, which builds the image and keeps the registry.
- Access to docker-host, which runs the container.
- The Gateway Auth `/verify` URL with its `team_id`.

## Build and push the image

Run these commands on your machine, in a checkout where the commit is pushed to GitHub. Replace `<commit>` with the commit hash.

```sh
docker --host ssh://docker-builder build -t localhost:5000/claude-proxy:<commit> https://github.com/carldr/claude-proxy.git#<commit>
docker --host ssh://docker-builder push localhost:5000/claude-proxy:<commit>
```

## Run the service

1. Copy `docker-compose.yml` to `/root/claude-proxy` on docker-host.
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
moss proxy add --domain claude-proxy.example.com --vm-name docker-host --target-port 4100
moss proxy set-gateway-auth-team-id --domain claude-proxy.example.com --gateway-auth-team-id <team ID>
```

Make a Gateway Auth token for each machine in your gateway-auth-repository checkout. The command prints the token once.

```sh
pnpm --silent --filter gateway-auth tokens add gateway-auth-claude-proxy <machine name>
```

## Update the service

1. Build and push the new commit.
2. Change `CLAUDE_PROXY_IMAGE` in `.env` to the new tag.
3. Run `docker compose up -d` in `/root/claude-proxy`.

The `claude-proxy-data` volume keeps `/data`, which holds the database, the grants of the subscription accounts and the certificates.

## Files

| File | Contents |
| --- | --- |
| `docker-compose.yml` | The `claude_proxy` service, its volume, its port and its healthcheck. |
| `../Dockerfile` | The image. It runs as the user `node`, with `/data` as the proxy directory. |
