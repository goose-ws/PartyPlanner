# Party Planner 🎲

A containerized D&D session scheduler designed for groups using Discord for D&D to coordinate availability without the headache.

## Features

- 📅 **Campaign Management**: Create multiple campaigns with static and dynamic recurrence patterns (e.g., "Every 2 weeks").
- 🔄 **Automated Poll Generation**: Automatically creates polls for upcoming sessions based on your schedule.
- 📊 **Availability Tracking**: Weighted scoring system (Yes/If Needed/Maybe/No) to objectively find the best date.
- ⚙️ **Configurable Deadlines**: Set custom "Response Warning" and "Decision" deadlines per campaign.
- 🤖 **Discord Integration**: Automated notifications for new polls, reminders for non-responders, and final schedule announcements.
- 📱 **Mobile Friendly**: Responsive design works on all devices.

## Quick Start (Docker Compose)

The easiest way to run Party Planner is using the pre-built image from GitHub Container Registry. It depends on you already having a MariaDB/MySQL backend up and running, with a user and database for Party Planner to use.

1. **Create a `docker-compose.yml` file:**

```yaml
services:
  partyplanner:
    image: ghcr.io/goose-ws/partyplanner:latest
    container_name: partyplanner
    hostname: partyplanner
    restart: unless-stopped
    depends_on:
      mariadb:
        condition: service_healthy
    ports:
      - "5000:5000"
    environment:
      DB_HOST: "mariadb"
      DB_USER: "partyplanner"
      DB_PASSWORD: "ChangeThisPassword"
      DB_NAME: "partyplanner"
      ADMIN_PASSWORD: "ChangeThisAdminPassword"
      SECRET_KEY: "GenerateARandomStringHere"
      APP_URL: "https://partyplanner.domain.tld"
      SESSION_TIMEOUT: "180d"
      NOTIFICATION_CRON: "0 8,20 * * *"
      TZ: "America/New_York"
      APP_ENV: "development"
    volumes:
      - "/etc/timezone:/etc/timezone:ro"
      - "/etc/localtime:/etc/localtime:ro"
    logging:
      driver: json-file
      options:
        max-file: "1"
        max-size: "10M"
```

2. **Run it:**
```bash
docker compose up -d

```

3. **Access the Interface:**
* Go to `http://localhost:5000` (or your configured domain)
* Log in with the `ADMIN_PASSWORD` you set.

## Configuration

### Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `DB_HOST` | Hostname or address for MariaDB/MySQL | `(Not set)` |
| `DB_USER` | Username for MariaDB/MySQL | `(Not set)` |
| `DB_PASSWORD` | Password for MariaDB/MySQL | `(Not set)` |
| `DB_NAME` | Name of the database to use for MariaDB/MySQL | `(Not set)` |
| `ADMIN_PASSWORD` | Password to access the admin panel | `admin123` (Unsafe) |
| `SECRET_KEY` | Key for signing session cookies (Set to a long, random string) | `dev-secret...` (Unsafe) |
| `APP_URL` | Public URL used in Discord links | `http://localhost:5000` |
| `SESSION_TIMEOUT` | Login duration (e.g., `12h`, `180d`) | `24h` |
| `NOTIFICATION_CRON` | Five field cron schedule for when you want scheduled tasks (Notifications) to be sent (e.g., `"0 8,20 * * *"`) | `"0 */6 * * *"` |
| `TZ` | Container Timezone | `UTC` |
| `APP_ENV` | Set to `production` to enable Secure/SameSite cookies (**Necessary if using HTTPS**) | `development` |

### Campaign Settings

* **Schedule Type**: Dynamic (every X days) or Static (e.g., every 2nd Thursday).
* **Deadlines**:
* *Response Warning*: How many days before the session to ping non-responders.
* *Decision Deadline*: How many days before the session to announce the best date.
* **Discord Webhook**: The URL for the channel where the bot should post.

### Discord Pings (Optional)

When adding players to a campaign, you can optionally provide their **Discord User ID**.

* **Purpose**: If a Discord ID is provided, the automated reminder notifications will **ping (@mention)** that specific user directly in Discord if they haven't voted yet. If no ID is provided, it will just list their name as plain text.
* **How to get a Discord ID**:
    1. Open Discord **Settings** → **Advanced** → Enable **Developer Mode**.
    2. Right-click on a user's profile (or their name in chat/member list).
    3. Select **Copy User ID**.
    4. Paste this numeric ID (e.g., `123456789012345678`) into the "Discord ID" field in Party Planner.

* **Discord Webhook**: The URL for the channel where the bot should post.

## Nginx Configuration

If you are running this behind an Nginx reverse proxy (recommended for SSL), here is a standard configuration block that supports WebSockets and proper header forwarding.

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name partyplanner.domain.tld;
    root /var/www/partyplanner.domain.tld;
    access_log /var/log/nginx/partyplanner.access.log;
    error_log /var/log/nginx/partyplanner.error.log;
    location /.well-known/ { allow all; }
    location / { return 301 https://partyplanner.domain.tld$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name partyplanner.domain.tld;
    root /var/www/partyplanner.domain.tld;
    access_log /var/log/nginx/partyplanner.access.log;
    error_log /var/log/nginx/partyplanner.error.log;
    
    ssl_certificate /etc/letsencrypt/live/partyplanner.domain.tld/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/partyplanner.domain.tld/privkey.pem;

    location / {
        # Set proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Important for WebSockets if needed later
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";

        # Docker DNS resolver (useful if container IPs change)
        resolver 127.0.0.11 valid=30s;
        set $upstream_app partyplanner;
        set $upstream_port 5000;
        set $upstream_proto http;
        proxy_pass $upstream_proto://$upstream_app:$upstream_port;
    }

    location /.well-known/ {
        allow all;
    }
}

```

## Scoring System

To help DMs make decisions, votes are weighted:

* **Yes**: +3 points
* **If Needed**: +2 points
* **Maybe**: +1 point
* **No**: 0 points (and zeroes the weight for that date if the user is the DM)
