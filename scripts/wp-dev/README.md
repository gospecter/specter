# wp-dev — throwaway WordPress for adapter smoke tests

A Docker WordPress + MariaDB stack with a one-shot bootstrap that installs WP,
creates an admin user, and generates an Application Password — the same auth
path the WordPress adapter uses in production.

## Prerequisites

- Docker Desktop running
- Port `8088` free (override with `WP_HOST_PORT=9090 npm run wp:up`)

## Usage

```bash
npm run wp:up      # boot + install + generate app password → .env.wp-dev
npm run wp:logs    # tail apache logs while you poke at it
npm run wp:reset   # destroy + reinstall (fresh DB, fresh app password)
npm run wp:down    # tear everything down, including the wp_data volume
```

After `wp:up`, `scripts/wp-dev/.env.wp-dev` contains:

```
WP_SITE_URL=http://localhost:8088
WP_USERNAME=specter
WP_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx
```

## Smoke test the adapter

```bash
set -a && source scripts/wp-dev/.env.wp-dev && set +a
node bin/ghost-sync.mjs test \
  --platform wordpress \
  --site-url "$WP_SITE_URL" \
  --username "$WP_USERNAME" \
  --app-password "$WP_APP_PASSWORD"
```

The admin UI lives at `http://localhost:8088/wp-admin` —
login is `specter` / `specter-dev-pass` (override with `WP_ADMIN_USER` /
`WP_ADMIN_PASS` env vars before `wp:up`).

## Notes

- MariaDB runs on a `tmpfs` mount — DB is ephemeral by design, gone on
  container restart. The `wp_data` named volume holds WP core files only;
  `wp:down` removes it (`-v`) so every `wp:up` is a clean slate unless you
  `docker compose stop` instead.
- `wp-cli` runs as UID 33 (www-data) to match file ownership inside the
  `wordpress` container — avoids the "permission denied on wp-content" trap.
- Application Passwords are core since WP 5.6 and require no plugin. The
  bootstrap creates a fresh one per run, named `specter-smoketest-<epoch>`.
