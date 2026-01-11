import os
import json
import secrets
import re
import time
from datetime import datetime, timedelta
from flask import Flask, render_template, request, jsonify, session, redirect, url_for
import mysql.connector
from mysql.connector import pooling
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
import requests
import pytz
from functools import wraps

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')

# Parse session timeout from environment variable
def parse_session_timeout(timeout_str):
    """Parse session timeout string like '12h' or '180d' into seconds"""
    if not timeout_str:
        return 86400  # Default 24 hours in seconds
    
    match = re.match(r'^(\d+)([hd])$', timeout_str.lower())
    if not match:
        print(f"Invalid SESSION_TIMEOUT format: {timeout_str}, using default 24h")
        return 86400
    
    value, unit = match.groups()
    value = int(value)
    
    if unit == 'h':
        return value * 3600  # hours to seconds
    elif unit == 'd':
        return value * 86400  # days to seconds
    
    return 86400

SESSION_TIMEOUT = parse_session_timeout(os.environ.get('SESSION_TIMEOUT', '24h'))
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(seconds=SESSION_TIMEOUT)

# Database configuration
DB_CONFIG = {
    'host': os.environ.get('DB_HOST', 'localhost'),
    'user': os.environ.get('DB_USER', 'root'),
    'password': os.environ.get('DB_PASSWORD', ''),
    'database': os.environ.get('DB_NAME', 'dnd_scheduler'),
    'pool_name': 'mypool',
    'pool_size': 5
}

ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'admin123')

# Create connection pool
try:
    connection_pool = pooling.MySQLConnectionPool(**DB_CONFIG)
except Exception as e:
    print(f"Error creating connection pool: {e}")
    connection_pool = None

def get_db():
    if connection_pool:
        return connection_pool.get_connection()
    return None

def init_db():
    conn = get_db()
    if not conn:
        return
    
    cursor = conn.cursor()
    
    # Campaigns table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS campaigns (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            is_active BOOLEAN DEFAULT FALSE,
            start_date DATE NOT NULL,
            schedule_type ENUM('dynamic', 'static') DEFAULT 'dynamic',
            recurrence_days INT NOT NULL,
            weekday INT,
            session_time_start TIME NOT NULL,
            session_time_end TIME NOT NULL,
            polls_in_advance INT DEFAULT 3,
            timezone VARCHAR(100) DEFAULT 'UTC',
            discord_webhook TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Players table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS players (
            id INT AUTO_INCREMENT PRIMARY KEY,
            campaign_id INT NOT NULL,
            name VARCHAR(255) NOT NULL,
            is_dm BOOLEAN DEFAULT FALSE,
            FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
            UNIQUE KEY unique_player_campaign (campaign_id, name)
        )
    ''')

    # Migration: Check for is_dm column
    try:
        cursor.execute("SELECT is_dm FROM players LIMIT 1")
        cursor.fetchall()  # <--- THIS LINE WAS MISSING. It clears the buffer.
    except Exception:
        print("Migrating database: Adding is_dm column to players table...")
        cursor.execute("ALTER TABLE players ADD COLUMN is_dm BOOLEAN DEFAULT FALSE")
    
    # Polls table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS polls (
            id INT AUTO_INCREMENT PRIMARY KEY,
            slug VARCHAR(16) UNIQUE NOT NULL,
            campaign_id INT NOT NULL,
            session_number INT,
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            is_closed BOOLEAN DEFAULT FALSE,
            selected_date DATE,
            is_manual BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            notified_created BOOLEAN DEFAULT FALSE,
            notified_two_weeks BOOLEAN DEFAULT FALSE,
            notified_one_week BOOLEAN DEFAULT FALSE,
            FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
            INDEX idx_slug (slug)
        )
    ''')
    
    # Responses table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS responses (
            id INT AUTO_INCREMENT PRIMARY KEY,
            poll_id INT NOT NULL,
            player_id INT NOT NULL,
            response_date DATE NOT NULL,
            availability ENUM('yes', 'if_needed', 'maybe', 'no') NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
            FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
            UNIQUE KEY unique_response (poll_id, player_id, response_date)
        )
    ''')
    
    conn.commit()
    cursor.close()
    conn.close()

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get('logged_in'):
            # Store the original URL they were trying to access
            session['next_url'] = request.url
            return redirect(url_for('login'))
        
        # Check if session has expired
        if 'login_time' in session:
            login_time = datetime.fromisoformat(session['login_time'])
            elapsed = (datetime.now() - login_time).total_seconds()
            
            if elapsed > SESSION_TIMEOUT:
                session.clear()
                return redirect(url_for('login'))
        
        return f(*args, **kwargs)
    return decorated_function

@app.route('/')
def index():
    return redirect(url_for('admin_panel'))

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        password = request.json.get('password', '')
        if password == ADMIN_PASSWORD:
            session.permanent = True
            session['logged_in'] = True
            session['login_time'] = datetime.now().isoformat()
            
            # Get the redirect URL if it exists
            next_url = session.pop('next_url', None)
            
            return jsonify({
                'success': True,
                'redirect': next_url if next_url else url_for('admin_panel')
            })
        return jsonify({'success': False, 'error': 'Invalid password'}), 401
    return render_template('login.html')

@app.route('/logout')
def logout():
    session.pop('logged_in', None)
    return redirect(url_for('login'))

@app.route('/admin')
@login_required
def admin_panel():
    return render_template('admin.html')

@app.route('/poll/<slug>')
@login_required
def poll_view(slug):
    return render_template('poll.html', poll_slug=slug)

# API Routes

@app.route('/api/campaigns', methods=['GET'])
@login_required
def get_campaigns():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute('SELECT * FROM campaigns ORDER BY is_active DESC, created_at DESC')
    campaigns = cursor.fetchall()
    
    for campaign in campaigns:
        # Convert timedelta and date objects to strings for JSON serialization
        if isinstance(campaign.get('session_time_start'), timedelta):
            total_seconds = int(campaign['session_time_start'].total_seconds())
            hours = total_seconds // 3600
            minutes = (total_seconds % 3600) // 60
            campaign['session_time_start'] = f"{hours:02d}:{minutes:02d}"
        
        if isinstance(campaign.get('session_time_end'), timedelta):
            total_seconds = int(campaign['session_time_end'].total_seconds())
            hours = total_seconds // 3600
            minutes = (total_seconds % 3600) // 60
            campaign['session_time_end'] = f"{hours:02d}:{minutes:02d}"
        
        if hasattr(campaign.get('start_date'), 'isoformat'):
            campaign['start_date'] = campaign['start_date'].isoformat()
        
        if hasattr(campaign.get('created_at'), 'isoformat'):
            campaign['created_at'] = campaign['created_at'].isoformat()
        
        cursor.execute('SELECT COUNT(*) as count FROM players WHERE campaign_id = %s', (campaign['id'],))
        campaign['player_count'] = cursor.fetchone()['count']
        
        cursor.execute('SELECT COUNT(*) as count FROM polls WHERE campaign_id = %s AND is_closed = FALSE', (campaign['id'],))
        campaign['active_polls'] = cursor.fetchone()['count']
    
    cursor.close()
    conn.close()
    return jsonify(campaigns)

@app.route('/api/campaigns', methods=['POST'])
@login_required
def create_campaign():
    data = request.json
    conn = get_db()
    cursor = conn.cursor()
    
    # If this campaign should be active, deactivate others
    if data.get('is_active'):
        cursor.execute('UPDATE campaigns SET is_active = FALSE')
    
    cursor.execute('''
        INSERT INTO campaigns (name, is_active, start_date, schedule_type, recurrence_days, 
                             weekday, session_time_start, session_time_end, polls_in_advance,
                             timezone, discord_webhook)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    ''', (
        data['name'],
        data.get('is_active', False),
        data['start_date'],
        data.get('schedule_type', 'dynamic'),
        data['recurrence_days'],
        data.get('weekday'),
        data['session_time_start'],
        data['session_time_end'],
        data.get('polls_in_advance', 3),
        data.get('timezone', 'UTC'),
        data.get('discord_webhook', '')
    ))
    
    campaign_id = cursor.lastrowid
    
    # Add players (This works for both create_campaign and update_campaign)
    if 'players' in data:
        for player in data['players']:
            # Handle both string (legacy) and dict (new) inputs
            if isinstance(player, dict):
                name = player.get('name')
                is_dm = player.get('is_dm', False)
            else:
                name = player
                is_dm = False
                
            cursor.execute('INSERT INTO players (campaign_id, name, is_dm) VALUES (%s, %s, %s)', 
                         (campaign_id, name, is_dm))
    
    conn.commit()
    cursor.close()
    conn.close()
    
    # Generate initial polls for this campaign
    generate_polls_for_campaign(campaign_id)
    
    return jsonify({'id': campaign_id, 'success': True})

@app.route('/api/campaigns/<int:campaign_id>', methods=['PUT'])
@login_required
def update_campaign(campaign_id):
    data = request.json
    conn = get_db()
    cursor = conn.cursor()
    
    # If this campaign should be active, deactivate others
    if data.get('is_active'):
        cursor.execute('UPDATE campaigns SET is_active = FALSE')
    
    cursor.execute('''
        UPDATE campaigns 
        SET name = %s, is_active = %s, start_date = %s, schedule_type = %s, 
            recurrence_days = %s, weekday = %s, session_time_start = %s, 
            session_time_end = %s, polls_in_advance = %s, timezone = %s, 
            discord_webhook = %s
        WHERE id = %s
    ''', (
        data['name'],
        data.get('is_active', False),
        data['start_date'],
        data.get('schedule_type', 'dynamic'),
        data['recurrence_days'],
        data.get('weekday'),
        data['session_time_start'],
        data['session_time_end'],
        data.get('polls_in_advance', 3),
        data.get('timezone', 'UTC'),
        data.get('discord_webhook', ''),
        campaign_id
    ))
    
    # Add players (This works for both create_campaign and update_campaign)
    if 'players' in data:
        for player in data['players']:
            # Handle both string (legacy) and dict (new) inputs
            if isinstance(player, dict):
                name = player.get('name')
                is_dm = player.get('is_dm', False)
            else:
                name = player
                is_dm = False
                
            cursor.execute('INSERT INTO players (campaign_id, name, is_dm) VALUES (%s, %s, %s)', 
                         (campaign_id, name, is_dm))
    
    conn.commit()
    cursor.close()
    conn.close()
    
    # Regenerate polls if needed
    generate_polls_for_campaign(campaign_id)
    
    return jsonify({'success': True})

@app.route('/api/campaigns/<int:campaign_id>', methods=['DELETE'])
@login_required
def delete_campaign(campaign_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('DELETE FROM campaigns WHERE id = %s', (campaign_id,))
    conn.commit()
    cursor.close()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/campaigns/<int:campaign_id>/players', methods=['GET'])
@login_required
def get_campaign_players(campaign_id):
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    
    # Updated to select is_dm
    cursor.execute('SELECT name, is_dm FROM players WHERE campaign_id = %s ORDER BY name', (campaign_id,))
    players = cursor.fetchall()
    
    cursor.close()
    conn.close()
    
    # Return the full object, not just the name string
    return jsonify({'players': players})

@app.route('/api/polls/all', methods=['GET'])
@login_required
def get_all_polls():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    
    cursor.execute('''
        SELECT p.*, c.name as campaign_name
        FROM polls p
        JOIN campaigns c ON p.campaign_id = c.id
        ORDER BY p.is_closed ASC, p.start_date DESC
    ''')
    polls = cursor.fetchall()
    
    for poll in polls:
        # Convert dates
        if hasattr(poll.get('start_date'), 'isoformat'):
            poll['start_date'] = poll['start_date'].isoformat()
        if hasattr(poll.get('end_date'), 'isoformat'):
            poll['end_date'] = poll['end_date'].isoformat()
        if hasattr(poll.get('selected_date'), 'isoformat'):
            poll['selected_date'] = poll['selected_date'].isoformat()
        if hasattr(poll.get('created_at'), 'isoformat'):
            poll['created_at'] = poll['created_at'].isoformat()
        
        # Get player count for campaign
        cursor.execute('SELECT COUNT(*) as count FROM players WHERE campaign_id = %s', (poll['campaign_id'],))
        poll['player_count'] = cursor.fetchone()['count']
        
        # Get response count
        cursor.execute('SELECT COUNT(DISTINCT player_id) as count FROM responses WHERE poll_id = %s', (poll['id'],))
        poll['response_count'] = cursor.fetchone()['count']
    
    cursor.close()
    conn.close()
    
    return jsonify({'polls': polls})

@app.route('/api/campaigns/<int:campaign_id>/stats')
@login_required
def get_campaign_stats(campaign_id):
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    
    # Get campaign info
    cursor.execute('SELECT * FROM campaigns WHERE id = %s', (campaign_id,))
    campaign = cursor.fetchone()
    
    if not campaign:
        cursor.close()
        conn.close()
        return jsonify({'error': 'Campaign not found'}), 404
    
    # Convert timedelta and date objects to strings
    if isinstance(campaign.get('session_time_start'), timedelta):
        total_seconds = int(campaign['session_time_start'].total_seconds())
        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        campaign['session_time_start'] = f"{hours:02d}:{minutes:02d}"
    
    if isinstance(campaign.get('session_time_end'), timedelta):
        total_seconds = int(campaign['session_time_end'].total_seconds())
        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        campaign['session_time_end'] = f"{hours:02d}:{minutes:02d}"
    
    if hasattr(campaign.get('start_date'), 'isoformat'):
        campaign['start_date'] = campaign['start_date'].isoformat()
    
    if hasattr(campaign.get('created_at'), 'isoformat'):
        campaign['created_at'] = campaign['created_at'].isoformat()
    
    # Get next scheduled session
    cursor.execute('''
        SELECT * FROM polls 
        WHERE campaign_id = %s AND is_closed = FALSE AND start_date >= CURDATE()
        ORDER BY start_date ASC LIMIT 1
    ''', (campaign_id,))
    next_poll = cursor.fetchone()
    
    if next_poll:
        if hasattr(next_poll.get('start_date'), 'isoformat'):
            next_poll['start_date'] = next_poll['start_date'].isoformat()
        if hasattr(next_poll.get('end_date'), 'isoformat'):
            next_poll['end_date'] = next_poll['end_date'].isoformat()
        if hasattr(next_poll.get('created_at'), 'isoformat'):
            next_poll['created_at'] = next_poll['created_at'].isoformat()
        if hasattr(next_poll.get('selected_date'), 'isoformat'):
            next_poll['selected_date'] = next_poll['selected_date'].isoformat()
    
    # Get active polls
    cursor.execute('''
        SELECT id, session_number, start_date, end_date, slug
        FROM polls 
        WHERE campaign_id = %s AND is_closed = FALSE
        ORDER BY start_date ASC
    ''', (campaign_id,))
    active_polls = cursor.fetchall()
    
    # Get response rates for active polls
    for poll in active_polls:
        if hasattr(poll.get('start_date'), 'isoformat'):
            poll['start_date'] = poll['start_date'].isoformat()
        if hasattr(poll.get('end_date'), 'isoformat'):
            poll['end_date'] = poll['end_date'].isoformat()
        
        cursor.execute('SELECT COUNT(*) as total FROM players WHERE campaign_id = %s', (campaign_id,))
        total_players = cursor.fetchone()['total']
        
        cursor.execute('''
            SELECT COUNT(DISTINCT player_id) as responded 
            FROM responses 
            WHERE poll_id = %s
        ''', (poll['id'],))
        responded = cursor.fetchone()['responded']
        
        poll['response_rate'] = f"{responded}/{total_players}"
    
    # Get past sessions
    cursor.execute('''
        SELECT * FROM polls 
        WHERE campaign_id = %s AND is_closed = TRUE AND selected_date IS NOT NULL
        ORDER BY selected_date DESC LIMIT 10
    ''', (campaign_id,))
    past_sessions = cursor.fetchall()
    
    for session in past_sessions:
        if hasattr(session.get('start_date'), 'isoformat'):
            session['start_date'] = session['start_date'].isoformat()
        if hasattr(session.get('end_date'), 'isoformat'):
            session['end_date'] = session['end_date'].isoformat()
        if hasattr(session.get('selected_date'), 'isoformat'):
            session['selected_date'] = session['selected_date'].isoformat()
        if hasattr(session.get('created_at'), 'isoformat'):
            session['created_at'] = session['created_at'].isoformat()
    
    # Calculate total sessions count
    cursor.execute('''
        SELECT COUNT(*) as total_sessions
        FROM polls 
        WHERE campaign_id = %s AND is_closed = TRUE AND selected_date IS NOT NULL
    ''', (campaign_id,))
    total_sessions = cursor.fetchone()['total_sessions']
    
    # Calculate player attendance stats
    cursor.execute('SELECT id, name FROM players WHERE campaign_id = %s', (campaign_id,))
    players = cursor.fetchall()
    
    player_attendance = []
    for player in players:
        # Count how many sessions this player voted 'yes' or 'if_needed' for
        cursor.execute('''
            SELECT COUNT(*) as attended
            FROM responses r
            JOIN polls p ON r.poll_id = p.id
            WHERE p.campaign_id = %s 
            AND r.player_id = %s 
            AND p.is_closed = TRUE 
            AND p.selected_date IS NOT NULL
            AND r.response_date = p.selected_date
            AND r.availability IN ('yes', 'if_needed')
        ''', (campaign_id, player['id']))
        attended = cursor.fetchone()['attended']
        
        attendance_rate = (attended / total_sessions * 100) if total_sessions > 0 else 0
        player_attendance.append({
            'name': player['name'],
            'attended': attended,
            'total': total_sessions,
            'percentage': round(attendance_rate, 1)
        })
    
    # Sort by attendance percentage
    player_attendance.sort(key=lambda x: x['percentage'], reverse=True)
    
    # Calculate best date/time (for dynamic scheduling)
    best_date_info = None
    if campaign['schedule_type'] == 'dynamic':
        # Analyze all closed polls to find the most common selected day of week
        cursor.execute('''
            SELECT selected_date 
            FROM polls 
            WHERE campaign_id = %s AND is_closed = TRUE AND selected_date IS NOT NULL
        ''', (campaign_id,))
        selected_dates = cursor.fetchall()
        
        if selected_dates:
            weekday_counts = {}
            for row in selected_dates:
                date_obj = row['selected_date']
                if hasattr(date_obj, 'weekday'):
                    weekday = date_obj.weekday()
                else:
                    date_obj = datetime.strptime(str(date_obj), '%Y-%m-%d').date()
                    weekday = date_obj.weekday()
                
                weekday_counts[weekday] = weekday_counts.get(weekday, 0) + 1
            
            if weekday_counts:
                best_weekday = max(weekday_counts, key=weekday_counts.get)
                weekday_names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
                best_date_info = {
                    'weekday': weekday_names[best_weekday],
                    'count': weekday_counts[best_weekday],
                    'total': len(selected_dates)
                }
    
    cursor.close()
    conn.close()
    
    return jsonify({
        'campaign': campaign,
        'next_poll': next_poll,
        'active_polls': active_polls,
        'past_sessions': past_sessions,
        'total_sessions': total_sessions,
        'player_attendance': player_attendance,
        'best_date_info': best_date_info
    })

def generate_slug():
    """Generate a random 8-character URL-safe slug"""
    return secrets.token_urlsafe(6)  # Generates ~8 characters

@app.route('/api/polls', methods=['POST'])
@login_required
def create_poll():
    data = request.json
    conn = get_db()
    cursor = conn.cursor()
    
    # Get next session number
    cursor.execute('''
        SELECT MAX(session_number) as max_num FROM polls WHERE campaign_id = %s
    ''', (data['campaign_id'],))
    result = cursor.fetchone()
    next_session = (result[0] or -1) + 1 if result[0] is not None else 0
    
    # Generate unique slug
    while True:
        slug = generate_slug()
        cursor.execute('SELECT id FROM polls WHERE slug = %s', (slug,))
        if not cursor.fetchone():
            break
    
    cursor.execute('''
        INSERT INTO polls (slug, campaign_id, session_number, start_date, end_date, is_manual)
        VALUES (%s, %s, %s, %s, %s, %s)
    ''', (
        slug,
        data['campaign_id'],
        next_session,
        data['start_date'],
        data['end_date'],
        data.get('is_manual', True)
    ))
    
    poll_id = cursor.lastrowid
    
    # Send notification if requested
    if data.get('send_notification', False):
        cursor.execute('SELECT discord_webhook, name FROM campaigns WHERE id = %s', (data['campaign_id'],))
        webhook_url, campaign_name = cursor.fetchone()
        if webhook_url:
            send_discord_notification(
                webhook_url,
                f"🎲 New poll created for {campaign_name} - Session {next_session}",
                f"Please vote on your availability from {data['start_date']} to {data['end_date']}",
                f"{request.url_root}poll/{slug}"
            )
    
    conn.commit()
    cursor.close()
    conn.close()
    
    return jsonify({'id': poll_id, 'slug': slug, 'success': True})

@app.route('/api/polls/<slug>', methods=['GET'])
@login_required
def get_poll(slug):
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    
    cursor.execute('''
        SELECT p.*, c.name as campaign_name, c.session_time_start, c.session_time_end, c.timezone
        FROM polls p
        JOIN campaigns c ON p.campaign_id = c.id
        WHERE p.slug = %s
    ''', (slug,))
    poll = cursor.fetchone()
    
    if not poll:
        cursor.close()
        conn.close()
        return jsonify({'error': 'Poll not found'}), 404
    
    # Convert timedelta and date objects to strings
    if isinstance(poll.get('session_time_start'), timedelta):
        total_seconds = int(poll['session_time_start'].total_seconds())
        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        poll['session_time_start'] = f"{hours:02d}:{minutes:02d}"
    
    if isinstance(poll.get('session_time_end'), timedelta):
        total_seconds = int(poll['session_time_end'].total_seconds())
        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        poll['session_time_end'] = f"{hours:02d}:{minutes:02d}"
    
    if hasattr(poll.get('start_date'), 'isoformat'):
        poll['start_date'] = poll['start_date'].isoformat()
    if hasattr(poll.get('end_date'), 'isoformat'):
        poll['end_date'] = poll['end_date'].isoformat()
    if hasattr(poll.get('selected_date'), 'isoformat'):
        poll['selected_date'] = poll['selected_date'].isoformat()
    if hasattr(poll.get('created_at'), 'isoformat'):
        poll['created_at'] = poll['created_at'].isoformat()
    
    # Get players
    cursor.execute('''
        SELECT * FROM players WHERE campaign_id = %s ORDER BY name
    ''', (poll['campaign_id'],))
    players = cursor.fetchall()
    
    # Get all dates in range
    start = datetime.strptime(str(poll['start_date']), '%Y-%m-%d').date()
    end = datetime.strptime(str(poll['end_date']), '%Y-%m-%d').date()
    dates = []
    current = start
    while current <= end:
        dates.append(str(current))
        current += timedelta(days=1)
    
    # Get responses
    cursor.execute('''
        SELECT r.*, pl.name as player_name
        FROM responses r
        JOIN players pl ON r.player_id = pl.id
        WHERE r.poll_id = %s
    ''', (poll['id'],))
    responses = cursor.fetchall()
    
    # Convert response dates to strings
    for response in responses:
        if hasattr(response.get('response_date'), 'isoformat'):
            response['response_date'] = response['response_date'].isoformat()
        if hasattr(response.get('updated_at'), 'isoformat'):
            response['updated_at'] = response['updated_at'].isoformat()
    
    # --- SCORING LOGIC START ---
    # Calculate scores for each date
    availability_weights = {'yes': 3, 'if_needed': 2, 'maybe': 1, 'no': 0}
    date_scores = {}
    
    # Identify the DM explicitly
    dm_player_id = None
    for p in players:
        # Check for 1, True, or just truthiness
        if p.get('is_dm') == 1 or p.get('is_dm') is True:
            dm_player_id = p['id']
            break
            
    # Debug print to check if DM is being found (Check your docker logs for this)
    print(f"DEBUG: Poll {slug} - Found DM Player ID: {dm_player_id}")
    
    for date in dates:
        score = 0
        dm_unavailable = False
        
        for response in responses:
            if str(response['response_date']) == date:
                # Check if this is the DM and they said NO
                if dm_player_id and response['player_id'] == dm_player_id:
                    if response['availability'] == 'no':
                        dm_unavailable = True
                        print(f"DEBUG: DM unavailable on {date}")
                
                score += availability_weights[response['availability']]
        
        # If DM is unavailable, score is 0 regardless of other votes
        if dm_unavailable:
            date_scores[date] = 0
        else:
            date_scores[date] = score
    # --- SCORING LOGIC END ---
    
    cursor.close()
    conn.close()
    
    return jsonify({
        'poll': poll,
        'players': players,
        'dates': dates,
        'responses': responses,
        'date_scores': date_scores
    })

@app.route('/api/polls/<slug>', methods=['DELETE'])
@login_required
def delete_poll(slug):
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    
    # Get the poll info before deleting
    cursor.execute('SELECT campaign_id, session_number FROM polls WHERE slug = %s', (slug,))
    poll_info = cursor.fetchone()
    
    if poll_info:
        campaign_id = poll_info['campaign_id']
        deleted_session_number = poll_info['session_number']
        
        # Delete the poll
        cursor.execute('DELETE FROM polls WHERE slug = %s', (slug,))
        
        # Renumber all sessions after the deleted one
        cursor.execute('''
            UPDATE polls 
            SET session_number = session_number - 1 
            WHERE campaign_id = %s AND session_number > %s
        ''', (campaign_id, deleted_session_number))
        
        conn.commit()
    
    cursor.close()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/polls/<slug>/close', methods=['POST'])
@login_required
def close_poll(slug):
    data = request.json
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    
    selected_date = data.get('selected_date')
    
    # Update the poll
    cursor.execute('UPDATE polls SET is_closed = TRUE, selected_date = %s WHERE slug = %s',
                  (selected_date, slug))
    
    # Send Discord notification
    cursor.execute('''
        SELECT p.session_number, c.name, c.discord_webhook, c.session_time_start, c.session_time_end, c.timezone
        FROM polls p
        JOIN campaigns c ON p.campaign_id = c.id
        WHERE p.slug = %s
    ''', (slug,))
    poll_info = cursor.fetchone()
    
    if poll_info and poll_info['discord_webhook']:
        # Generate the link URL
        # We use request.url_root to ensure it matches the user's browser context
        poll_url = f"{request.url_root}poll/{slug}"

        if selected_date:
            start_time = poll_info['session_time_start']
            end_time = poll_info['session_time_end']
            
            # Format times
            if isinstance(start_time, timedelta):
                total_seconds = int(start_time.total_seconds())
                hours = total_seconds // 3600
                minutes = (total_seconds % 3600) // 60
                start_time = f"{hours:02d}:{minutes:02d}"
            
            if isinstance(end_time, timedelta):
                total_seconds = int(end_time.total_seconds())
                hours = total_seconds // 3600
                minutes = (total_seconds % 3600) // 60
                end_time = f"{hours:02d}:{minutes:02d}"
            
            send_discord_notification(
                poll_info['discord_webhook'],
                f"📅 Scheduled: {poll_info['name']} - Session {poll_info['session_number']}",
                f"**{poll_info['name']}** will meet on **{selected_date}** at {start_time}-{end_time} {poll_info['timezone']}",
                poll_url
            )
        else:
            send_discord_notification(
                poll_info['discord_webhook'],
                f"🚫 Cancelled: {poll_info['name']} - Session {poll_info['session_number']}",
                f"No suitable date was found for Session {poll_info['session_number']}",
                poll_url
            )
    
    conn.commit()
    cursor.close()
    conn.close()
    
    return jsonify({'success': True})

@app.route('/api/polls/<slug>/reopen', methods=['POST'])
@login_required
def reopen_poll(slug):
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute('UPDATE polls SET is_closed = FALSE, selected_date = NULL WHERE slug = %s', (slug,))
    
    conn.commit()
    cursor.close()
    conn.close()
    
    return jsonify({'success': True})

@app.route('/api/responses', methods=['POST'])
@login_required
def save_response():
    data = request.json
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute('''
        INSERT INTO responses (poll_id, player_id, response_date, availability)
        VALUES (%s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE availability = %s
    ''', (
        data['poll_id'],
        data['player_id'],
        data['response_date'],
        data['availability'],
        data['availability']
    ))
    
    conn.commit()
    cursor.close()
    conn.close()
    
    return jsonify({'success': True})

@app.route('/api/responses/delete', methods=['POST'])
@login_required
def delete_response():
    data = request.json
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute('''
        DELETE FROM responses 
        WHERE poll_id = %s AND player_id = %s AND response_date = %s
    ''', (
        data['poll_id'],
        data['player_id'],
        data['response_date']
    ))
    
    conn.commit()
    cursor.close()
    conn.close()
    
    return jsonify({'success': True})

def send_discord_notification(webhook_url, title, description, link=None):
    if not webhook_url:
        return
    
    embed = {
        "title": title,
        "description": description,
        "color": 5814783  # Purple color
    }
    
    if link:
        embed["url"] = link
    
    payload = {
        "embeds": [embed]
    }
    
    try:
        # Retry up to 3 times
        for attempt in range(3):
            response = requests.post(webhook_url, json=payload)
            
            # If successful, we are done
            if response.status_code in [200, 204]:
                return
            
            # If rate limited (429), wait and retry
            if response.status_code == 429:
                retry_after = response.json().get('retry_after', 1)
                # printOutput 3 f"Rate limit hit. Waiting {retry_after}s..."
                time.sleep(retry_after)
                continue
            
            # If other error, print and break
            print(f"Failed to send Discord notification: {response.status_code} - {response.text}")
            break
            
    except Exception as e:
        print(f"Error sending Discord notification: {e}")

def generate_polls_for_campaign(campaign_id):
    """Generate polls for a specific campaign up to polls_in_advance"""
    conn = get_db()
    if not conn:
        return
    
    cursor = conn.cursor(dictionary=True)
    cursor.execute('SELECT * FROM campaigns WHERE id = %s', (campaign_id,))
    campaign = cursor.fetchone()
    
    if not campaign:
        cursor.close()
        conn.close()
        return
    
    tz = pytz.timezone(campaign['timezone'])
    now = datetime.now(tz).date()
    
    # Get existing polls
    cursor.execute('''
        SELECT session_number, start_date FROM polls 
        WHERE campaign_id = %s 
        ORDER BY session_number DESC
    ''', (campaign['id'],))
    existing_polls = cursor.fetchall()
    
    # Determine next session number and date
    if existing_polls:
        last_session = existing_polls[0]['session_number']
        last_date = existing_polls[0]['start_date']
        next_session = last_session + 1
        
        # Calculate next date based on last poll's start date
        days_to_add = campaign['recurrence_days']
        next_date = last_date + timedelta(days=days_to_add)
    else:
        # First poll
        next_session = 0
        next_date = campaign['start_date']
    
    # Create polls up to polls_in_advance
    current_poll_count = len([p for p in existing_polls if p['start_date'] >= now])
    
    while current_poll_count < campaign['polls_in_advance']:
        # Create poll spanning 2 weeks
        poll_start = next_date
        poll_end = next_date + timedelta(days=13)
        
        # Generate unique slug
        while True:
            slug = generate_slug()
            cursor.execute('SELECT id FROM polls WHERE slug = %s', (slug,))
            if not cursor.fetchone():
                break
        
        cursor.execute('''
            INSERT INTO polls (slug, campaign_id, session_number, start_date, end_date, is_manual)
            VALUES (%s, %s, %s, %s, %s, FALSE)
        ''', (slug, campaign['id'], next_session, poll_start, poll_end))
        
        poll_id = cursor.lastrowid
        
        # Send creation notification
        if campaign['discord_webhook']:
            send_discord_notification(
                campaign['discord_webhook'],
                f"🎲 New poll created for {campaign['name']} - Session {next_session}",
                f"Please vote on your availability from {poll_start} to {poll_end}",
                f"{os.environ.get('APP_URL', 'http://localhost:5000')}/poll/{slug}"
            )
            cursor.execute('UPDATE polls SET notified_created = TRUE WHERE id = %s', (poll_id,))
        
        next_session += 1
        
        # Calculate next date based on schedule type
        if campaign['schedule_type'] == 'static' and campaign['weekday'] is not None:
            # Static: find next occurrence of the target weekday
            target_weekday = campaign['weekday']
            recurrence_weeks = campaign['recurrence_days'] // 7
            next_date = next_date + timedelta(weeks=recurrence_weeks)
            
            # Adjust to the target weekday if needed
            current_weekday = next_date.weekday()
            if current_weekday != target_weekday:
                days_ahead = (target_weekday - current_weekday) % 7
                next_date = next_date + timedelta(days=days_ahead)
        else:
            # Dynamic: add recurrence days
            next_date += timedelta(days=campaign['recurrence_days'])
        
        current_poll_count += 1
    
    conn.commit()
    cursor.close()
    conn.close()

def check_and_create_polls():
    """Background job to create polls for active campaigns"""
    conn = get_db()
    if not conn:
        return
    
    cursor = conn.cursor(dictionary=True)
    cursor.execute('SELECT id FROM campaigns WHERE is_active = TRUE')
    campaigns = cursor.fetchall()
    cursor.close()
    conn.close()
    
    for campaign in campaigns:
        generate_polls_for_campaign(campaign['id'])

def check_notifications():
    """Background job to send Discord notifications"""
    conn = get_db()
    if not conn:
        return
    
    cursor = conn.cursor(dictionary=True)
    
    # Get all open polls with their campaigns
    cursor.execute('''
        SELECT p.*, c.name as campaign_name, c.discord_webhook, c.timezone,
               c.session_time_start, c.session_time_end
        FROM polls p
        JOIN campaigns c ON p.campaign_id = c.id
        WHERE p.is_closed = FALSE AND c.discord_webhook IS NOT NULL AND c.discord_webhook != ''
    ''')
    polls = cursor.fetchall()
    
    for poll in polls:
        tz = pytz.timezone(poll['timezone'])
        now = datetime.now(tz).date()
        
        two_weeks_before = poll['start_date'] - timedelta(days=14)
        one_week_before = poll['start_date'] - timedelta(days=7)
        
        # Two week notification
        if now >= two_weeks_before and not poll['notified_two_weeks']:
            # Get players who haven't responded
            cursor.execute('''
                SELECT pl.name FROM players pl
                WHERE pl.campaign_id = %s
                AND pl.id NOT IN (
                    SELECT DISTINCT player_id FROM responses WHERE poll_id = %s
                )
            ''', (poll['campaign_id'], poll['id']))
            
            non_responders = [row['name'] for row in cursor.fetchall()]
            
            if non_responders:
                send_discord_notification(
                    poll['discord_webhook'],
                    f"⏰ Reminder: {poll['campaign_name']} - Session {poll['session_number']} Poll",
                    f"**Still need responses from:** {', '.join(non_responders)}",
                    f"{os.environ.get('APP_URL', 'http://localhost:5000')}/poll/{poll['slug']}"
                )
            
            cursor.execute('UPDATE polls SET notified_two_weeks = TRUE WHERE id = %s', (poll['id'],))
        
        # One week notification
        if now >= one_week_before and not poll['notified_one_week']:
            # Calculate best dates
            cursor.execute('''
                SELECT response_date, 
                       SUM(CASE availability
                           WHEN 'yes' THEN 3
                           WHEN 'if_needed' THEN 2
                           WHEN 'maybe' THEN 1
                           ELSE 0
                       END) as score
                FROM responses
                WHERE poll_id = %s
                GROUP BY response_date
                ORDER BY score DESC
            ''', (poll['id'],))
            
            results = cursor.fetchall()
            
            if results:
                best_score = results[0]['score']
                best_dates = [str(r['response_date']) for r in results if r['score'] == best_score]
                
                # Convert times
                start_time = poll['session_time_start']
                end_time = poll['session_time_end']
                
                if isinstance(start_time, timedelta):
                    total_seconds = int(start_time.total_seconds())
                    hours = total_seconds // 3600
                    minutes = (total_seconds % 3600) // 60
                    start_time = f"{hours:02d}:{minutes:02d}"
                
                if isinstance(end_time, timedelta):
                    total_seconds = int(end_time.total_seconds())
                    hours = total_seconds // 3600
                    minutes = (total_seconds % 3600) // 60
                    end_time = f"{hours:02d}:{minutes:02d}"
                
                if len(best_dates) == 1:
                    message = f"**Best date:** {best_dates[0]} at {start_time}-{end_time}"
                else:
                    message = f"**Tie between:** {', '.join(best_dates)} -- Please manually select a date!"
                
                send_discord_notification(
                    poll['discord_webhook'],
                    f"📊 Results: {poll['campaign_name']} - Session {poll['session_number']}",
                    message,
                    f"{os.environ.get('APP_URL', 'http://localhost:5000')}/poll/{poll['slug']}"
                )
            
            cursor.execute('UPDATE polls SET notified_one_week = TRUE WHERE id = %s', (poll['id'],))
    
    conn.commit()
    cursor.close()
    conn.close()

# Initialize scheduler
scheduler = BackgroundScheduler()
scheduler.add_job(check_and_create_polls, CronTrigger(hour=0, minute=0))  # Daily at midnight
scheduler.add_job(check_notifications, CronTrigger(hour='*/6'))  # Every 6 hours
scheduler.start()

if __name__ == '__main__':
    init_db()
    
    # Generate polls for all active campaigns on startup
    try:
        conn = get_db()
        if conn:
            cursor = conn.cursor(dictionary=True)
            cursor.execute('SELECT id FROM campaigns WHERE is_active = TRUE')
            campaigns = cursor.fetchall()
            cursor.close()
            conn.close()
            
            for campaign in campaigns:
                generate_polls_for_campaign(campaign['id'])
    except Exception as e:
        print(f"Error generating initial polls: {e}")
    
    app.run(host='0.0.0.0', port=5000, debug=False)