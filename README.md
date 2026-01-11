# D&D Session Scheduler

A Docker-based scheduling application designed for D&D groups to coordinate session availability.

## Features

- 📅 **Campaign Management**: Create multiple campaigns with configurable recurrence patterns
- 🔄 **Automated Poll Generation**: Automatically creates polls for upcoming sessions
- 📊 **Availability Tracking**: Players vote Yes/If Needed/Maybe/No with weighted scoring
- 🤖 **Discord Integration**: Automated notifications for new polls, reminders, and scheduling
- 📱 **Mobile Friendly**: Responsive design works on all devices
- 🔐 **Simple Auth**: Single admin password for trusted groups
- ⏰ **Timezone Aware**: Proper timezone handling for distributed groups

## Quick Start

### Prerequisites

- Docker and Docker Compose installed
- MariaDB instance (can be external or use included docker-compose)
- Discord webhook URL (optional but recommended)

### Installation

1. **Clone or create project directory**:
```bash
mkdir dnd-scheduler
cd dnd-scheduler
```

2. **Create the following files** with the code provided:
   - `Dockerfile`
   - `requirements.txt`
   - `app.py`
   - `docker-compose.yml`
   - Create a `templates/` directory with:
     - `login.html`
     - `admin.html`
     - `poll.html`

3. **Configure environment variables** in `docker-compose.yml`:
```yaml
environment:
  - DB_HOST=your-mariadb-host
  - DB_USER=your-db-user
  - DB_PASSWORD=your-db-password
  - DB_NAME=dnd_scheduler
  - ADMIN_PASSWORD=your-secure-password
  - SECRET_KEY=generate-a-random-secret-key
  - APP_URL=http://your-domain.com
  - SESSION_TIMEOUT=24h  # How long users stay logged in
```

**Session Timeout Options:**
- Format: `{number}{h|d}` where h=hours, d=days
- Examples: `12h` (12 hours), `7d` (7 days), `180d` (6 months)
- Default: `24h` if not specified

4. **Build and run**:
```bash
docker-compose up -d
```

5. **Access the application**:
   - Navigate to `http://localhost:5000`
   - Login with your configured ADMIN_PASSWORD
   - Create your first campaign!

## Configuration

### Environment Variables

- **DB_HOST**: MariaDB host address
- **DB_USER**: Database user
- **DB_PASSWORD**: Database password
- **DB_NAME**: Database name (will be auto-created if doesn't exist)
- **ADMIN_PASSWORD**: Password for admin panel access
- **SECRET_KEY**: Random secret key for session security (generate with `python -c "import secrets; print(secrets.token_hex(32))"`)
- **APP_URL**: Public URL of your application (used in Discord notification links)
- **SESSION_TIMEOUT**: How long users stay logged in (format: `12h` or `7d`, default: `24h`)

### Campaign Settings

- **Name**: Campaign identifier
- **Start Date**: When the campaign begins
- **Recurrence**: Days between sessions (e.g., 14 for bi-weekly)
- **Session Times**: Default start and end times
- **Polls in Advance**: How many future polls to maintain (recommended: 3)
- **Timezone**: Your local timezone
- **Discord Webhook**: For automated notifications
- **Players**: List of player names

### Discord Webhook Setup

1. In Discord, go to Server Settings → Integrations → Webhooks
2. Create a new webhook for your D&D channel
3. Copy the webhook URL
4. Paste it into your campaign settings

### Automated Notifications

The system sends Discord notifications:

- **New Poll Created**: When automation generates a new poll
- **2 Weeks Before**: Lists players who haven't responded
- **1 Week Before**: Announces best date(s) or indicates a tie
- **Session Scheduled**: When admin selects final date

## Usage

### Creating a Campaign

1. Click "New Campaign" in admin panel
2. Fill in campaign details
3. Add player names
4. Set as active if this is your current campaign
5. Save

### Managing Polls

**Automated**: The system automatically creates polls based on your recurrence schedule

**Manual**: Click "+ Poll" on any campaign to create additional polls

### Voting

1. Navigate to a poll (from admin panel or Discord link)
2. Click any cell to cycle through: Yes → If Needed → Maybe → No
3. Responses auto-save and scores update in real-time

### Closing Polls

1. Review the best-scored dates (highlighted in green)
2. Click "Select Date & Close Poll"
3. Choose the final date
4. System sends Discord announcement and closes poll

## Scoring System

- **Yes**: +3 points
- **If Needed**: +2 points
- **Maybe**: +1 point
- **No**: 0 points

The date(s) with the highest total score are highlighted as best options.

## Database

The application automatically creates the necessary database tables on first run:

- `campaigns`: Campaign configurations
- `players`: Player names per campaign
- `polls`: Individual polls with date ranges
- `responses`: Player availability responses

## Nginx Reverse Proxy

To use with Nginx, add this to your config:

```nginx
location /scheduler/ {
    proxy_pass http://localhost:5000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Update `APP_URL` environment variable to match your public URL.

## Troubleshooting

**Can't connect to database**: 
- Verify DB_HOST, DB_USER, DB_PASSWORD, and DB_NAME are correct
- Ensure MariaDB is accessible from the container

**Notifications not sending**:
- Verify Discord webhook URL is correct
- Check that APP_URL is set properly
- Review Docker logs: `docker logs dnd-scheduler`

**Polls not auto-creating**:
- Check that campaign is marked as "Active"
- Verify the scheduler is running (check logs)
- Ensure start date and recurrence are set correctly

## Technical Details

- **Backend**: Python Flask
- **Database**: MariaDB (MySQL compatible)
- **Scheduler**: APScheduler for background jobs
- **Frontend**: Vanilla JavaScript, responsive CSS

## License

This is a personal project. Feel free to use and modify as needed.

## Support

For issues or questions, check the application logs:
```bash
docker logs dnd-scheduler
```