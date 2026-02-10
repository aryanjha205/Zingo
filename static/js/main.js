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

const servers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
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

async function startSync() {
    console.log("Starting Sync Loop...");
    setInterval(async () => {
        // 1. Heartbeat
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
    }, 1500); // 1.5s interval
}

// --- WebRTC & Matching Logic ---

async function handleNewPartner(pUid, initiator) {
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
            await apiCall('send_signal', { partner_uid: partnerUid, signal: offer });
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
            apiCall('send_signal', { partner_uid: partnerUid, signal: { candidate: event.candidate } });
        }
    };

    peerConnection.ontrack = (event) => {
        console.log("Received remote track");
        remoteVideo.srcObject = event.streams[0];
    };

    peerConnection.oniceconnectionstatechange = () => {
        console.log("ICE State:", peerConnection.iceConnectionState);
    };
}

async function handleSignal(signal) {
    if (!peerConnection) initPeerConnection();

    try {
        if (signal.type === 'offer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            await apiCall('send_signal', { partner_uid: partnerUid, signal: answer });
        } else if (signal.type === 'answer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.candidate) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
    } catch (e) { console.error("Signal Handling Error:", e); }
}

function closeConnection() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    remoteVideo.srcObject = null;
    partnerUid = null;
}

// --- UI Event Listeners ---

startBtn.addEventListener('click', async () => {
    console.log("Start Clicked");
    if (!localStream) await initMedia();
    if (!localStream) return;

    isFinding = true;
    partnerStatus.textContent = "Looking for someone...";
    partnerStatus.style.display = "block";
    addSystemMessage("Searching for partner...");

    const data = await apiCall('find_partner');
    if (data && data.status === 'matched') {
        handleNewPartner(data.partner_uid, true);
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

    const data = await apiCall('find_partner');
    if (data && data.status === 'matched') {
        handleNewPartner(data.partner_uid, true);
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
