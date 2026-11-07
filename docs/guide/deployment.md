# Deployment

Inkvoice ships as a single Docker container that serves both the API and the frontend. It works with any platform that supports Docker.

## Dokploy

Inkvoice is an [official Dokploy template](https://dokploy.com/templates/inkvoice). That is the one-click path.

1. Install [Dokploy](https://dokploy.com) on your server if you haven't already.
2. In your Dokploy panel, open a project and click **Create Service → Template**.
3. Search for **Inkvoice** and click **Create**.
4. Deploy. Dokploy generates `ADMIN_PASS` and `JWT_SECRET`, mounts `/app/data`, and routes a domain to port `3000`.
5. Sign in as `admin` with the generated password (under the service's environment variables).

The catalog template ships `COOKIE_SECURE=false` so login works on Dokploy's auto-generated HTTP domain. After you attach an HTTPS custom domain, set `COOKIE_SECURE=true` and `ENABLE_HSTS=true`.

The catalog template pins a specific release tag, which can trail the newest release. Check the image tag in the Compose service and bump it if it is behind.

To deploy a fork or a custom tag instead of the catalog template, add a Compose/Docker service from this repo, expose port `3000`, mount `/app/data`, and set:

- `ADMIN_USER` — your admin username
- `ADMIN_PASS` — a strong password
- `JWT_SECRET` — a random string (32+ characters)

::: tip
Generate a random JWT secret:
```bash
openssl rand -base64 48
```
:::

## Coolify

1. Create a new resource and select **Docker Compose** or **Dockerfile**
2. Connect your GitHub repository
3. Set the environment variables (same as above)
4. Add a persistent storage volume mapped to `/app/data`
5. Deploy

## Plain Docker

```bash
docker run -d \
  --name inkvoice \
  -p 3000:3000 \
  -v invoice-data:/app/data \
  -e ADMIN_USER=admin \
  -e ADMIN_PASS=your-strong-password \
  -e JWT_SECRET=your-random-secret-at-least-32-chars \
  ghcr.io/pigontech/inkvoice:latest
```

## Kubernetes (k3s)

Ready-to-apply manifests live in [`deploy/k3s/`](https://github.com/pigontech/inkvoice/tree/main/deploy/k3s). They target k3s defaults (the `local-path` storage class and the bundled Traefik ingress), but work on any cluster.

```bash
# 1. Secrets (never committed)
kubectl create secret generic inkvoice \
  --from-literal=JWT_SECRET="$(openssl rand -base64 48)" \
  --from-literal=ADMIN_PASS='your-strong-password'

# 2. Edit the host in deploy/k3s/ingress.yaml and PUBLIC_BASE_URL in
#    deploy/k3s/deployment.yaml, then apply
kubectl apply -k deploy/k3s
```

Keep these in mind:

- **Always one replica.** The database is a SQLite file and the scheduler (recurring invoices, reminders, auto-billing) runs inside the process. A second pod would write the same database and send duplicate emails and charges. The Deployment uses `replicas: 1` with the `Recreate` strategy for this reason. Don't add a HorizontalPodAutoscaler.
- **The volume is `ReadWriteOnce`.** With `local-path` the pod is tied to the node that holds the data. Use Longhorn or another replicated storage class if it needs to move between nodes.
- **Pin the image tag.** The manifest uses a release tag rather than `latest`. To upgrade, change the tag and re-apply.
- **Stripe and PayPal webhooks must reach the cluster.** If the cluster is only reachable on your LAN, expose `/api/v1/webhooks/*` publicly (for example through a Cloudflare Tunnel), or online payments will never be confirmed.
- **Client IPs.** Login rate limiting keys on `X-Forwarded-For`, which Traefik sets. If another proxy sits in front of the ingress, make sure it forwards the real client IP.

To back up, copy the database out of the pod:

```bash
kubectl cp "$(kubectl get pod -l app=inkvoice -o name | cut -d/ -f2)":/app/data/invoice.db \
  ./backup-$(date +%F).db
```

## Reverse Proxy

Inkvoice runs on a single port (default 3000). Place it behind your preferred reverse proxy for SSL termination.

### Nginx

```nginx
server {
    listen 443 ssl;
    server_name invoices.example.com;

    ssl_certificate /etc/ssl/certs/your-cert.pem;
    ssl_certificate_key /etc/ssl/private/your-key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Caddy

```
invoices.example.com {
    reverse_proxy localhost:3000
}
```

## Backups

The entire application state lives in a single SQLite file at `DATABASE_PATH` (default: `/app/data/invoice.db`). To back it up:

```bash
# Copy from a running container
docker cp inkvoice:/app/data/invoice.db ./backup-$(date +%F).db

# Or straight from the named volume. Plain `docker run` creates `invoice-data`;
# Docker Compose prefixes it with the project name, so use `inkvoice_invoice-data`.
# Check with: docker volume ls
docker run --rm -v invoice-data:/data -v $(pwd):/backup \
  alpine cp /data/invoice.db /backup/backup-$(date +%F).db
```

Schedule this with cron for automated backups. SQLite supports safe reads while the app is running.

## Updating

```bash
docker compose pull
docker compose up -d
```

Database migrations run automatically on startup.
