import eventlet
eventlet.monkey_patch()
import os
import certifi
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
from pymongo import MongoClient
from datetime import datetime, timezone
import uuid
import threading
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'zingo_secret_key_2026')
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# MongoDB Connection
MONGO_URI = os.environ.get("MONGO_URI", "mongodb+srv://streetsofahmedabad2_db_user:mAEtqTMGGmEOziVE@cluster0.9u0xk1w.mongodb.net/")
reports_col = None
sessions_col = None
logs_col = None
db_connected = False

def connect_to_mongodb():
    global reports_col, sessions_col, logs_col, db_connected
    print(">>> [INFO] MongoDB: Connecting in background...")
    try:
        # Increased timeout slightly for slow networks, but in background so it doesn't block
        temp_client = MongoClient(
            MONGO_URI, 
            tlsCAFile=certifi.where(),
            connectTimeoutMS=15000,
            serverSelectionTimeoutMS=15000,
            socketTimeoutMS=15000
        )
        # Force a connection check
        temp_client.admin.command('ping')
        
        target_db = temp_client['zingo_db']
        reports_col = target_db['reports']
        sessions_col = target_db['sessions']
        logs_col = target_db['moderation_logs']
        db_connected = True
        print(">>> [SUCCESS] MongoDB: Background connection established")
    except Exception as e:
        print(f">>> [WARNING] MongoDB: Background connection failed: {e}")
        print(">>> [INFO] MongoDB: Features requiring database will be disabled")

# Start connection in background thread
threading.Thread(target=connect_to_mongodb, daemon=True).start()

# State management
waiting_users = []  # List of sid
active_rooms = {}   # sid -> room_id
room_members = {}   # room_id -> [sid1, sid2]

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/stats')
def get_stats():
    count = 0
    if sessions_col:
        count = sessions_col.count_documents({})
    return jsonify({"online_users": count})

import random

ADJECTIVES = ["Neon", "Silver", "Cyber", "Global", "Arctic", "Solar", "Vortex", "Elite"]
NOUNS = ["Falcon", "Tiger", "Ghost", "Runner", "Sage", "Knight", "Oracle", "Spark"]

def get_online_count():
    if sessions_col:
        return sessions_col.count_documents({})
    return 0

@socketio.on('connect')
def handle_connect(auth=None):
    identity = f"{random.choice(ADJECTIVES)} {random.choice(NOUNS)} {random.randint(10, 99)}"
    if sessions_col:
        sessions_col.update_one({'sid': request.sid}, {'$set': {'identity': identity, 'joined_at': datetime.now(timezone.utc)}}, upsert=True)
    
    current_count = get_online_count()
    emit('identity_assigned', {'identity': identity})
    emit('update_count', {'count': current_count}, broadcast=True)
    print(f"User connected: {request.sid} as {identity}. Total: {current_count}")

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    
    # Remove from MongoDB sessions first
    if sessions_col:
        sessions_col.delete_one({'sid': sid})
    
    # Remove from waiting queue if present
    if sid in waiting_users:
        waiting_users.remove(sid)
    
    # Notify partner if in a room
    if sid in active_rooms:
        room_id = active_rooms.pop(sid)
        members = room_members.get(room_id, [])
        if sid in members:
            members.remove(sid)
        
        emit('partner_disconnected', room=room_id, include_self=False)
        
        # Cleanup room
        if not members:
            room_members.pop(room_id, None)
        else:
            # The remaining person is now alone in the room, cleanup their mapping
            for m_sid in members:
                active_rooms.pop(m_sid, None)
                
    current_count = get_online_count()
    emit('update_count', {'count': current_count}, broadcast=True)
    print(f"User disconnected: {sid}. Total: {current_count}")

@socketio.on('find_partner')
def find_partner():
    sid = request.sid
    
    # If already in a room, leave it
    if sid in active_rooms:
        old_room = active_rooms.pop(sid)
        members = room_members.get(old_room, [])
        if sid in members: members.remove(sid)
        emit('partner_disconnected', room=old_room, include_self=False)
        leave_room(old_room)

    if waiting_users and waiting_users[0] != sid:
        partner_sid = waiting_users.pop(0)
        room_id = str(uuid.uuid4())
        
        active_rooms[sid] = room_id
        active_rooms[partner_sid] = room_id
        room_members[room_id] = [sid, partner_sid]
        
        # Get identities
        user1_data = {'identity': 'Anonymous'}
        user2_data = {'identity': 'Anonymous'}
        
        if sessions_col:
            user1_data = sessions_col.find_one({'sid': sid}) or user1_data
            user2_data = sessions_col.find_one({'sid': partner_sid}) or user2_data
        
        # Notify both users
        emit('found_partner', {'room_id': room_id, 'initiator': True, 'partner_identity': user2_data['identity']}, room=sid)
        emit('join_private_room', {'room_id': room_id, 'initiator': False, 'partner_identity': user1_data['identity']}, room=partner_sid)
        
        print(f"Matched {sid} with {partner_sid} in room {room_id}")
    else:
        if sid not in waiting_users:
            waiting_users.append(sid)
        emit('waiting', {'message': 'Searching for a partner...'})

@socketio.on('join_room')
def on_join(data):
    room = data['room_id']
    join_room(room)
    print(f"User {request.sid} joined room {room}")

@socketio.on('signal')
def handle_signal(data):
    room = active_rooms.get(request.sid)
    if room:
        emit('signal', data, room=room, include_self=False)

@socketio.on('chat_message')
def handle_chat(data):
    room = active_rooms.get(request.sid)
    if room:
        emit('chat_message', {'msg': data['msg'], 'sender': request.sid}, room=room)

@socketio.on('typing')
def handle_typing(data):
    # data: {'typing': True/False}
    room = active_rooms.get(request.sid)
    if room:
        emit('partner_typing', {'typing': data['typing'], 'sender': request.sid}, room=room, include_self=False)

@socketio.on('report_user')
def handle_report(data):
    sid = request.sid
    room_id = active_rooms.get(sid)
    partner_sid = None
    
    if room_id:
        members = room_members.get(room_id, [])
        for m in members:
            if m != sid:
                partner_sid = m
                break

    report = {
        'reporter': sid,
        'reported': partner_sid,
        'reason': data.get('reason'),
        'timestamp': datetime.now(timezone.utc)
    }
    if reports_col:
        reports_col.insert_one(report)
    emit('report_received', {'status': 'success'})

@socketio.on('update_interests')
def handle_interests(data):
    # This can be used later for targeted matching logic
    print(f"User {request.sid} updated interests: {data.get('interests')}")

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5011))
    print(f">>> [INFO] Server: Starting on http://127.0.0.1:{port}")
    socketio.run(app, debug=True, port=port, host='0.0.0.0', use_reloader=False)
