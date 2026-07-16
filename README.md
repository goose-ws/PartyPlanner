# Party Planner

Ground-up rewrite. Node.js/TypeScript + Express backend, MariaDB (external,
you already run one), React SPA frontend (not yet built — see status below),
deployed as a single Alpine container behind your existing nginx reverse
proxy.

## Status (foundation phase)

Built so far:
- Config loader: env vars > `/app/data/config.json` > defaults. Secrets
  (DB password, Discord client secret, session signing key, token encryption
  key) are **always** env-only and never touch disk.
- Full DB schema + Knex migrations, run automatically on container boot
  before the web port opens.
- **Legacy data safety net**: on boot, if the old Flask app's tables
  (`players`, `polls`, `responses`, etc.) are detected, they're renamed to
  `legacy_*` and a JSON snapshot is written to `/app/data/legacy-exports/`
  before the new migrations run. Fully idempotent — safe to restart
  repeatedly. No attempt is made to convert old poll/response data into the
  new schema (the models are too different); it's just preserved.
- Discord OAuth2 login (manual implementation, no passport dependency),
  refresh tokens encrypted at rest (AES-256-GCM).
- Sliding-window session cookies, effectively indefinite login (renewed
  automatically once <90% of the 1-year lifetime remains).
- Three-tier ACL: global `root`, per-campaign `DM`, per-campaign `Player`.
- Campaign invites: DMs generate Player-only invite links; only root can mint
  a DM-granting invite. Links are revocable, support optional expiry and
  use-limits, and optional SMTP email delivery (no-ops cleanly if SMTP isn't
  configured). Redemption skips the Discord round-trip entirely if you're
  already logged in.

Not yet built: the scheduling/scoring engine, session lifecycle, attendance
stats, the frontend, and `.ics`/calendar export.

## First boot

1. Copy `.env.example` to `.env`, fill in the required secrets (see comments
   in that file — `openssl rand -hex 32` for the two generated keys).
2. Register a Discord application at https://discord.com/developers/applications,
   set its OAuth2 redirect URI to `<PUBLIC_URL>/auth/callback`.
3. `docker compose up --build`. On first boot the container:
   - archives any legacy tables it finds,
   - runs migrations,
   - seeds your `INITIAL_ROOT_DISCORD_ID` as a placeholder root user (their
     real username fills in on first Discord login),
   - writes non-secret settings to `/app/data/config.json`.
4. After that first boot, `INITIAL_ROOT_DISCORD_ID` and the other
   now-persisted values can be dropped from `.env`/compose — only the four
   secrets need to keep being supplied.

## Reverse proxy

The container binds `PORT` (default 3000) with no host port published.
Point nginx's `proxy_pass` at the compose service name (`partyplanner`) on
the shared docker network, and forward `X-Forwarded-Proto`/`X-Forwarded-For`
so OAuth redirect URIs resolve as `https`.
