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

**Easiest path — the setup wizard:**

1. Register a Discord application at https://discord.com/developers/applications,
   set its OAuth2 redirect URI to `<PUBLIC_URL>/auth/callback`.
2. Make sure a MariaDB database and user exist for the app to use (the app
   won't create these itself — just the schema inside them).
3. `docker compose up --build` with `.env` empty. The container boots into
   a minimal setup-only mode — visit the app in a browser and fill in the
   wizard (public URL, DB connection, Discord credentials, your Discord
   user ID for root). It's saved to `/app/data/config.json` (owner-read-only;
   secrets live here now, same trust boundary as the `.env` file it
   replaces — see the comment at the top of that file for the reasoning).
4. `docker compose restart partyplanner` to boot normally. Migrations run,
   your root user gets seeded, and the app is live.

**Alternative — env vars**, same as before: fill in `.env` per `.env.example`
and skip the wizard entirely; env values always take precedence over
`config.json` if both are set. Useful if you manage secrets externally
(vault, CI/CD, etc.) rather than through the app's own UI.

Once things are running, root can review/change everything under
**Core Settings** in the app itself (top bar, root only) — though most
changes there still need a container restart to take effect, since config
is loaded once at boot.

## Reverse proxy

The container binds `PORT` (default 3000) with no host port published.
Point nginx's `proxy_pass` at the compose service name (`partyplanner`) on
the shared docker network, and forward `X-Forwarded-Proto`/`X-Forwarded-For`
so OAuth redirect URIs resolve as `https`.
