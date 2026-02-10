// Generate a unique ID for this session
const uid = Math.random().toString(36).substring(2, 15);
console.log("Session UID:", uid);

const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const startBtn = document.getElementById('start-btn');
const nextBtn = document.getElementById('next-btn');
const stopBtn = document.getElementById('stop-btn');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const chatMessages = document.getElementById('chat-messages');
const partnerStatus = document.getElementById('partner-status');
const onlineCountSpan = document.getElementById('online-count');
const reportBtn = document.getElementById('report-btn');
const reportModal = document.getElementById('report-modal');
const cancelReport = document.getElementById('cancel-report');
const confirmReport = document.getElementById('confirm-report');
const reportReason = document.getElementById('report-reason');

let localStream;
let peerConnection;
let partnerUid = null;
let isInitiator = false;
let isFinding = false;
let outgoingSignals = []; // Queue for signals to be sent in batch
let iceQueue = []; // Queue for incoming ICE candidates until remote description is set

const servers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10
};

// --- Initialization ---

async function initMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        console.log("Media Initialized");
    } catch (err) {
        console.error("Error accessing media devices.", err);
        addSystemMessage("Error: Please allow camera/microphone permissions.");
    }
}

// --- API Helpers ---

async function apiCall(endpoint, data = {}) {
    try {
        const res = await fetch(`/api/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid, ...data })
        });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return await res.json();
    } catch (err) {
        console.error(`API Error (${endpoint}):`, err);
        return null;
    }
}

// --- Sync Loop ---

let syncInterval;
let currentInterval = 1000;

let isSyncing = false;

async function syncTick() {
    if (isSyncing) return;
    isSyncing = true;
    try {
        const hb = await apiCall('heartbeat');
        if (hb && hb.online_count !== undefined) {
            onlineCountSpan.textContent = hb.online_count;
        }

        // 2. Sync (Signals & Messages)
        const data = await apiCall('sync');
        if (!data) return;

        // Handle match discovery
        if (data.partner_uid && !partnerUid) {
            console.log("Sync found partner:", data.partner_uid);
            handleNewPartner(data.partner_uid, false);
        } else if (!data.partner_uid && partnerUid) {
            console.log("Sync found partner left");
            handlePartnerLeft();
        }

        // Handle Messages
        if (data.messages && data.messages.length > 0) {
            data.messages.forEach(msg => {
                addChatMessage(msg.message, 'partner');
            });
        }

        // Handle Signals
        if (data.signals && data.signals.length > 0) {
            data.signals.forEach(async (s) => {
                await handleSignal(s.signal);
            });
        }

        // 3. Send queued signals in parallel
        if (outgoingSignals.length > 0 && partnerUid) {
            const signalsToSend = [...outgoingSignals];
            outgoingSignals = [];
            signalsToSend.forEach(signal => {
                apiCall('send_signal', { partner_uid: partnerUid, signal });
            });
        }

        // Dynamic Interval Control
        let nextInterval = 1000;
        if (partnerUid && peerConnection && (peerConnection.iceConnectionState !== 'connected' && peerConnection.iceConnectionState !== 'completed')) {
            nextInterval = 150; // Ultra-aggressive 150ms polling during handshake
        } else if (isFinding) {
            nextInterval = 300; // Fast when searching
        } else if (partnerUid) {
            nextInterval = 600; // Normal chat speed
        }

        if (nextInterval !== currentInterval) {
            currentInterval = nextInterval;
            clearInterval(syncInterval);
            syncInterval = setInterval(syncTick, currentInterval);
        }
    } catch (err) {
        console.error("syncTick Error:", err);
    } finally {
        isSyncing = false;
    }
}

async function startSync() {
    console.log("Starting Sync Loop...");
    syncInterval = setInterval(syncTick, currentInterval);
}

// --- WebRTC & Matching Logic ---

async function handleNewPartner(pUid, initiator) {
    if (partnerUid === pUid) return; // Already matched with this partner
    console.log("Handling new partner:", pUid, "Initiator:", initiator);
    partnerUid = pUid;
    isInitiator = initiator;
    isFinding = false;
    partnerStatus.style.display = "none";
    addSystemMessage("Partner found! Connecting...");

    initPeerConnection();

    if (isInitiator) {
        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            outgoingSignals.push(offer);
            syncTick(); // Force immediate send
        } catch (e) { console.error("Offer creation error:", e); }
    }

    startBtn.disabled = true;
    nextBtn.disabled = false;
    stopBtn.disabled = false;
}

function handlePartnerLeft() {
    addSystemMessage("Partner disconnected.");
    closeConnection();
    if (!isFinding && !startBtn.disabled) {
        partnerStatus.textContent = "Partner left.";
        partnerStatus.style.display = "block";
    }
}

function initPeerConnection() {
    if (peerConnection) return;
    console.log("Initializing Peer Connection");

    peerConnection = new RTCPeerConnection(servers);

    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }

    peerConnection.onicecandidate = (event) => {
        if (event.candidate && partnerUid) {
            // Add to queue instead of individual API calls
            outgoingSignals.push({ candidate: event.candidate });
        }
    };

    peerConnection.ontrack = (event) => {
        console.log("Received remote track");
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
        }
    };

    peerConnection.oniceconnectionstatechange = () => {
        console.log("ICE State:", peerConnection.iceConnectionState);
        if (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed') {
            addSystemMessage("Connected! Say hi!");
            partnerStatus.style.display = "none";
        } else if (peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'disconnected') {
            addSystemMessage("Connection failed. Try clicking 'Next'.");
            handlePartnerLeft();
        }
    };
}

async function handleSignal(signal) {
    if (!peerConnection) initPeerConnection();

    try {
        if (signal.type === 'offer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));

            // Process queued candidates
            while (iceQueue.length > 0) {
                const candidate = iceQueue.shift();
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            }

            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            outgoingSignals.push(answer);
            syncTick();
        } else if (signal.type === 'answer') {
            if (peerConnection.signalingState === "have-local-offer") {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));

                // Process queued candidates
                while (iceQueue.length > 0) {
                    const candidate = iceQueue.shift();
                    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                }
            }
        } else if (signal.candidate) {
            if (peerConnection.remoteDescription) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
            } else {
                iceQueue.push(signal.candidate);
            }
        }
    } catch (e) { console.error("Signal Handling Error:", e); }
}

function closeConnection() {
    if (peerConnection) {
        peerConnection.onicecandidate = null;
        peerConnection.ontrack = null;
        peerConnection.oniceconnectionstatechange = null;
        peerConnection.close();
        peerConnection = null;
    }
    remoteVideo.srcObject = null;
    partnerUid = null;
    iceQueue = [];
}

// --- UI Event Listeners ---

startBtn.addEventListener('click', async () => {
    console.log("Start Clicked");
    if (!localStream) {
        partnerStatus.textContent = "Accessing camera...";
        await initMedia();
    }
    if (!localStream) return;

    isFinding = true;
    partnerStatus.textContent = "Looking for someone...";
    partnerStatus.style.display = "block";
    addSystemMessage("Searching for partner...");

    // Immediate interval speed up
    if (currentInterval !== 150) {
        currentInterval = 150;
        clearInterval(syncInterval);
        syncInterval = setInterval(syncTick, currentInterval);
    }

    const data = await apiCall('find_partner');
    if (data && data.status === 'matched') {
        handleNewPartner(data.partner_uid, true);
    } else {
        // Force an immediate sync tick to catch any rapid matches
        syncTick();
    }

    startBtn.disabled = true;
    nextBtn.disabled = false;
    stopBtn.disabled = false;
});

nextBtn.addEventListener('click', async () => {
    console.log("Next Clicked");
    closeConnection();
    addSystemMessage("Skipping partner...");
    chatMessages.innerHTML = "";

    isFinding = true;
    partnerStatus.textContent = "Looking for someone...";
    partnerStatus.style.display = "block";

    // Immediate interval speed up
    if (currentInterval !== 150) {
        currentInterval = 150;
        clearInterval(syncInterval);
        syncInterval = setInterval(syncTick, currentInterval);
    }

    const data = await apiCall('find_partner');
    if (data && data.status === 'matched') {
        handleNewPartner(data.partner_uid, true);
    } else {
        syncTick();
    }
});

stopBtn.addEventListener('click', async () => {
    console.log("Stop Clicked");
    closeConnection();
    await apiCall('find_partner', { stop: true });

    isFinding = false;
    startBtn.disabled = false;
    nextBtn.disabled = true;
    stopBtn.disabled = true;
    partnerStatus.textContent = "Stopped. Press Start to play again.";
    partnerStatus.style.display = "block";
    addSystemMessage("Session stopped.");
});

async function sendMessage() {
    const text = chatInput.value.trim();
    if (text && partnerUid) {
        const res = await apiCall('send_message', { partner_uid: partnerUid, message: text });
        if (res && res.status === 'sent') {
            addChatMessage(text, 'me');
            chatInput.value = "";
        }
    }
}

sendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

function addChatMessage(text, sender) {
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('message', sender);
    msgDiv.textContent = text;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('system-msg');
    msgDiv.textContent = text;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// --- Reporting ---

reportBtn.addEventListener('click', () => {
    if (partnerUid) reportModal.style.display = 'flex';
});

cancelReport.addEventListener('click', () => { reportModal.style.display = 'none'; });

confirmReport.addEventListener('click', async () => {
    await apiCall('report', { partner_uid: partnerUid, reason: reportReason.value });
    reportModal.style.display = 'none';
    addSystemMessage("User reported.");
    nextBtn.click();
});

// Start everything
console.log("Zingo App Initializing...");
initMedia();
startSync();
