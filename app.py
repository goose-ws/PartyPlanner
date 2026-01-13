import os
import json
import secrets
import re
import time
from datetime import datetime, timedelta
from flask import Flask, render_template, request, jsonify, session, redirect, url_for, abort
from flask_wtf.csrf import CSRFProtect
import mysql.connector
from mysql.connector import pooling
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
import requests
import pytz
from functools import wraps

app = Flask(__name__)
if os.environ.get('SECRET_KEY') is None:
    print("WARNING: SECRET_KEY not set. Using insecure default for sessions.")
    
if os.environ.get('ADMIN_PASSWORD') is None:
    print("WARNING: ADMIN_PASSWORD not set. Default password 'admin123' is active.")

app.secret_key = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')

# Initialize CSRF Protection
csrf = CSRFProtect(app)

# Security Headers (Add these config updates)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    # Set to True ONLY if you are running on HTTPS. If testing on HTTP localhost, keep False.
    SESSION_COOKIE_SECURE=os.environ.get('APP_ENV') == 'production'
)

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
    'pool_size': 5,
    'use_pure': True,
    'charset': 'utf8mb4'
}

ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'admin123')

# Create connection pool
# Initialize to None globally
connection_pool = None
def get_db_pool():
    """Lazily initialize the connection pool if it doesn't exist"""
    global connection_pool
    if connection_pool:
        return connection_pool
        
    try:
        print("Attempting to initialize database connection pool...")
        connection_pool = pooling.MySQLConnectionPool(**DB_CONFIG)
        return connection_pool
    except Exception as e:
        print(f"Error creating connection pool: {e}")
        return None

def get_db():
    # Try to get or create the pool
    pool = get_db_pool()
    
    if not pool:
        print("Error: Database connection pool could not be initialized.")
        abort(503, description="Database unavailable. Please try again later.")
    
    try:
        return pool.get_connection()
    except Exception as e:
        print(f"Error getting connection from pool: {e}")
        abort(503, description="Database temporarily unavailable. Please try again.")

def init_db():
    # Use the helper to try and get the pool
    pool = get_db_pool()
    
    if not pool:
        print("Database pool not initialized. Skipping DB init.")
        return

    try:
        conn = pool.get_connection()
    except Exception as e:
        print(f"Skipping DB init: Could not connect to database: {e}")
        return
    
    cursor = conn.cursor()
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS audit_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            ip_address VARCHAR(45) NOT NULL,
            action VARCHAR(50) NOT NULL,
            details TEXT,
            resource_type VARCHAR(50),
            resource_id INT
        )
    ''')
    conn.commit()
    
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
        cursor.fetchall()
    except Exception:
        print("Migrating database: Adding is_dm column to players table...")
        try:
            cursor.execute("ALTER TABLE players ADD COLUMN is_dm BOOLEAN DEFAULT FALSE")
        except mysql.connector.Error as err:
            if err.errno != 1060: # 1060 = Duplicate column name
                raise err
        
    # Migration: Deadlines
    try:
        cursor.execute("SELECT deadline_respond FROM campaigns LIMIT 1")
        cursor.fetchall()
    except Exception:
        print("Migrating database: Adding deadline columns to campaigns table...")
        try:
            # We wrap these in a try/except to handle the race condition
            # where another worker might add the column while we are checking.
            cursor.execute("ALTER TABLE campaigns ADD COLUMN deadline_respond INT DEFAULT 14")
            cursor.execute("ALTER TABLE campaigns ADD COLUMN deadline_decide INT DEFAULT 7")
        except mysql.connector.Error as err:
            # Error 1060 means "Duplicate column name".
            # If we get this, it means another worker finished the migration first.
            # We can safely ignore it and continue.
            if err.errno == 1060:
                print("Migration race condition handled: Columns already exist.")
            else:
                # If it's any other error, we actually want to crash so we know about it.
                raise err
    
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
    
# Close DB connection automatically at the end of every request
@app.teardown_appcontext
def close_db_connection(exception):
    pass

@app.route('/admin')
@login_required
def admin_panel():
    return render_template('admin.html')

@app.route('/poll/<slug>')
@login_required
def poll_view(slug):
    return render_template('poll.html', poll_slug=slug)

def log_audit(action, details=None, resource_type=None, resource_id=None):
    try:
        conn = get_db()
        if not conn:
            return
            
        cursor = conn.cursor()
        
        # Determine IP Address
        ip_address = "System"
        try:
            # Check if we are in a Flask request context
            if request:
                # Trust X-Forwarded-For because you use Nginx
                if request.headers.get('X-Forwarded-For'):
                    ip_address = request.headers.get('X-Forwarded-For').split(',')[0]
                else:
                    ip_address = request.remote_addr
        except RuntimeError:
            # We are in a background job (scheduler), no request context exists
            pass

        cursor.execute('''
            INSERT INTO audit_log (ip_address, action, details, resource_type, resource_id)
            VALUES (%s, %s, %s, %s, %s)
        ''', (ip_address, action, details, resource_type, resource_id))
        
        conn.commit()
        cursor.close()
        conn.close()
    except Exception as e:
        print(f"Failed to write audit log: {e}")

@app.route('/audit')
@login_required
def audit_view():
    return render_template('audit.html')

@app.route('/api/audit')
@login_required
def get_audit_logs():
    try:
        conn = get_db()
        cursor = conn.cursor(dictionary=True)
        # Limit to last 500 events to prevent browser lag
        cursor.execute('''
            SELECT * FROM audit_log 
            ORDER BY timestamp DESC 
            LIMIT 500
        ''')
        logs = cursor.fetchall()
        
        for log in logs:
            if hasattr(log.get('timestamp'), 'isoformat'):
                log['timestamp'] = log['timestamp'].isoformat()
                
        cursor.close()
        conn.close()
        return jsonify({'logs': logs})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

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
                             timezone, discord_webhook, deadline_respond, deadline_decide)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
        data.get('deadline_respond', 14),
        data.get('deadline_decide', 7)
    ))
    
    campaign_id = cursor.lastrowid
    log_audit('CAMPAIGN_CREATE', f"Created campaign '{data['name']}'", 'campaign', campaign_id)
    
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
            discord_webhook = %s, deadline_respond = %s, deadline_decide = %s
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
        data.get('deadline_respond', 14),
        data.get('deadline_decide', 7),
        campaign_id
    ))
    
    # Update players
    if 'players' in data:
        provided_names = []
        for player in data['players']:
            # Handle both string (legacy) and dict (new) inputs
            if isinstance(player, dict):
                name = player.get('name')
                is_dm = player.get('is_dm', False)
            else:
                name = player
                is_dm = False
                
            provided_names.append(name)
                
            # FIX: Use ON DUPLICATE KEY UPDATE to update existing players instead of crashing
            cursor.execute('''
                INSERT INTO players (campaign_id, name, is_dm) 
                VALUES (%s, %s, %s)
                ON DUPLICATE KEY UPDATE is_dm = VALUES(is_dm)
            ''', (campaign_id, name, is_dm))
            
        # Handle deletions: Remove players that are no longer in the list
        if provided_names:
            placeholders = ', '.join(['%s'] * len(provided_names))
            sql = f"DELETE FROM players WHERE campaign_id = %s AND name NOT IN ({placeholders})"
            cursor.execute(sql, [campaign_id] + provided_names)
        else:
            # If the list was explicitly cleared
            cursor.execute("DELETE FROM players WHERE campaign_id = %s", (campaign_id,))
            
    action_type = 'CAMPAIGN_UPDATE'
    if data.get('is_active') is False:
        action_type = 'CAMPAIGN_PAUSE'
    elif data.get('is_active') is True:
        action_type = 'CAMPAIGN_RESUME'
        
    log_audit(action_type, f"Updated campaign '{data['name']}'", 'campaign', campaign_id)
    
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
    log_audit('CAMPAIGN_DELETE', f"Deleted campaign ID {campaign_id}", 'campaign', campaign_id)
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
    log_audit('POLL_CREATE', f"Created session {next_session} poll ({data['start_date']} to {data['end_date']})", 'poll', poll_id)
    
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
    log_audit('POLL_DELETE', f"Deleted poll {slug}", 'poll', None)
    
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
    status = "Scheduled" if selected_date else "Cancelled"
    log_audit('POLL_CLOSE', f"Poll {slug} closed. Result: {status} ({selected_date})", 'poll', None)
    
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
    log_audit('POLL_REOPEN', f"Reopened poll {slug}", 'poll', None)
    
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
    
    # 1. Lookup Player Name for the Audit Log
    player_name = f"Player {data['player_id']}" # Default fallback
    try:
        cursor.execute('SELECT name FROM players WHERE id = %s', (data['player_id'],))
        result = cursor.fetchone()
        if result:
            player_name = result[0]
    except Exception:
        pass # If lookup fails, we stick with "Player 8"

    # 2. Save the Vote
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
    
    # 3. Log using the actual name
    log_audit('VOTE_CAST', f"{player_name} voted '{data['availability']}' on {data['response_date']}", 'response', data['poll_id'])
    
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
    
    # 1. Lookup Name
    player_name = f"Player {data['player_id']}"
    try:
        cursor.execute('SELECT name FROM players WHERE id = %s', (data['player_id'],))
        result = cursor.fetchone()
        if result:
            player_name = result[0]
    except Exception:
        pass

    # 2. Delete Response
    cursor.execute('''
        DELETE FROM responses 
        WHERE poll_id = %s AND player_id = %s AND response_date = %s
    ''', (
        data['poll_id'],
        data['player_id'],
        data['response_date']
    ))
    
    # 3. Log it
    log_audit('VOTE_CLEAR', f"{player_name} cleared vote for {data['response_date']}", 'response', data['poll_id'])
    
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
                log_audit('NOTIFICATION_SENT', f"Sent Discord notification: {title}", 'system', None)
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
    # Get all open polls with their campaigns
    cursor.execute('''
        SELECT p.*, c.name as campaign_name, c.discord_webhook, c.timezone,
               c.session_time_start, c.session_time_end,
               c.deadline_respond, c.deadline_decide
        FROM polls p
        JOIN campaigns c ON p.campaign_id = c.id
        WHERE p.is_closed = FALSE AND c.discord_webhook IS NOT NULL AND c.discord_webhook != ''
    ''')
    polls = cursor.fetchall()
    
    for poll in polls:
        tz = pytz.timezone(poll['timezone'])
        now = datetime.now(tz).date()
        
        # USE CONFIGURABLE DEADLINES
        respond_days = poll.get('deadline_respond', 14)
        decide_days = poll.get('deadline_decide', 7)
        
        deadline_respond_date = poll['start_date'] - timedelta(days=respond_days)
        deadline_decide_date = poll['start_date'] - timedelta(days=decide_days)
        
        # Respond Notification
        if now >= deadline_respond_date and not poll['notified_two_weeks']:
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
        if now >= deadline_decide_date and not poll['notified_one_week']:
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