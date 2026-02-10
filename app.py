import os
import time
import certifi
from flask import Flask, render_template, request, jsonify
from pymongo import MongoClient
from bson.objectid import ObjectId
from flask_cors import CORS

app = Flask(__name__)
app.config['SECRET_KEY'] = 'zingo_secret_key_2026'
CORS(app)

# MongoDB Atlas Setup
MONGO_URI = os.environ.get("MONGO_URI", "mongodb+srv://streetsofahmedabad2_db_user:mAEtqTMGGmEOziVE@cluster0.9u0xk1w.mongodb.net/")
try:
    client = MongoClient(MONGO_URI, tlsCAFile=certifi.where(), serverSelectionTimeoutMS=5000)
    client.admin.command('ping')
    db = client['zingo_db']
    reports_col = db['reports']
    sessions_col = db['sessions']
    waiting_col = db['waiting_room']
    matches_col = db['active_matches']
    messages_col = db['messages']
    signals_col = db['signals']
except Exception as e:
    print(f"MongoDB Connection Error: {e}")
    db = None

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/heartbeat', methods=['POST'])
def heartbeat():
    data = request.json or {}
    uid = data.get('uid')
    if db is None or not uid: return jsonify({'online_count': 1})
    
    now = time.time()
    sessions_col.update_one(
        {'uid': uid},
        {'$set': {'last_seen': now, 'status': 'online'}},
        upsert=True
    )
    
    active_threshold = now - 30 # User must have seen in last 30s
    online_count = sessions_col.count_documents({'last_seen': {'$gt': active_threshold}})
    
    return jsonify({'online_count': max(1, online_count)})

@app.route('/api/find_partner', methods=['POST'])
def find_partner():
    data = request.json or {}
    uid = data.get('uid')
    is_stop = data.get('stop', False)
    
    if db is None or not uid: return jsonify({'status': 'error'})

    # If stop, remove from everything
    if is_stop:
        matches_col.delete_many({'$or': [{'uid1': uid}, {'uid2': uid}]})
        waiting_col.delete_one({'uid': uid})
        return jsonify({'status': 'stopped'})

    # 1. Clean up stale waiting entries
    waiting_col.delete_many({'timestamp': {'$lt': time.time() - 30}})

    # 2. Check if already matched
    existing_match = matches_col.find_one({'$or': [{'uid1': uid}, {'uid2': uid}]})
    if existing_match:
        p_uid = existing_match['uid2'] if existing_match['uid1'] == uid else existing_match['uid1']
        return jsonify({'status': 'matched', 'partner_uid': p_uid, 'is_initiator': False})

    # 3. Try to find someone waiting (not self)
    partner = waiting_col.find_one_and_delete({'uid': {'$ne': uid}})
    if partner:
        p_uid = partner['uid']
        # Double check if partner is still online (in last 30s)
        p_session = sessions_col.find_one({'uid': p_uid, 'last_seen': {'$gt': time.time() - 30}})
        if p_session:
            matches_col.insert_one({'uid1': uid, 'uid2': p_uid, 'created_at': time.time()})
            return jsonify({'status': 'matched', 'partner_uid': p_uid, 'is_initiator': True})
    
    # 4. If no partner, join waiting room
    waiting_col.update_one(
        {'uid': uid},
        {'$set': {'timestamp': time.time()}},
        upsert=True
    )
    return jsonify({'status': 'waiting'})

@app.route('/api/sync', methods=['POST'])
def sync():
    data = request.json or {}
    uid = data.get('uid')
    if db is None or not uid: return jsonify({'status': 'error'})
    
    # Check match status
    match = matches_col.find_one({'$or': [{'uid1': uid}, {'uid2': uid}]})
    partner_uid = None
    if match:
        partner_uid = match['uid2'] if match['uid1'] == uid else match['uid1']
        # Update match activity
        matches_col.update_one({'_id': match['_id']}, {'$set': {'last_activity': time.time()}})
    
    # Get incoming messages
    incoming_messages = list(messages_col.find({'to_uid': uid}))
    messages_col.delete_many({'to_uid': uid})
    
    # Get incoming signals
    incoming_signals = list(signals_col.find({'to_uid': uid}))
    signals_col.delete_many({'to_uid': uid})
    
    for m in incoming_messages: del m['_id']
    for s in incoming_signals: del s['_id']
    
    return jsonify({
        'partner_uid': partner_uid,
        'messages': incoming_messages,
        'signals': incoming_signals
    })

@app.route('/api/send_message', methods=['POST'])
def send_message():
    data = request.json or {}
    uid = data.get('uid')
    partner_uid = data.get('partner_uid')
    text = data.get('message', '')[:1000]
    
    if db is None or not uid or not partner_uid: return jsonify({'status': 'error'})
    
    messages_col.insert_one({'from_uid': uid, 'to_uid': partner_uid, 'message': text, 'timestamp': time.time()})
    return jsonify({'status': 'sent'})

@app.route('/api/send_signal', methods=['POST'])
def send_signal():
    data = request.json or {}
    uid = data.get('uid')
    partner_uid = data.get('partner_uid')
    signal = data.get('signal')
    
    if db is None or not uid or not partner_uid: return jsonify({'status': 'error'})
    
    signals_col.insert_one({'from_uid': uid, 'to_uid': partner_uid, 'signal': signal, 'timestamp': time.time()})
    return jsonify({'status': 'sent'})

@app.route('/api/report', methods=['POST'])
def report():
    data = request.json or {}
    uid = data.get('uid')
    partner_uid = data.get('partner_uid')
    reason = data.get('reason')
    
    if db is None: return jsonify({'status': 'error'})
    reports_col.insert_one({'reporter': uid, 'reported': partner_uid, 'reason': reason, 'timestamp': time.time()})
    return jsonify({'status': 'reported'})

if __name__ == '__main__':
    app.run(debug=True)
