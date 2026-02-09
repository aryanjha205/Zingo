const socket = io();
let localStream;
let remoteStream;
let peerConnection;
let roomID;

const config = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// Elements
const landingPage = document.getElementById('landing-page');
const appContainer = document.getElementById('app-container');
const startBtn = document.getElementById('start-btn');
const nextBtn = document.getElementById('next-btn');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-msg');
const chatMessages = document.getElementById('chat-messages');
const onlineCountElem = document.getElementById('online-count');
const searchingOverlay = document.getElementById('searching-overlay');
const reportBtn = document.getElementById('report-btn');
const reportModal = document.getElementById('report-modal');
const reportOptions = document.querySelectorAll('.report-option');

socket.on('connect', () => {
    console.log("Connected to Socket.io server", socket.id);
    addChatMessage("SYSTEM", "CORE UPLINK STABLE.");
});

socket.on('connect_error', (error) => {
    console.error("Socket connection error:", error);
    addChatMessage("SYSTEM", "SIGNAL INTERFERENCE DETECTED.");
});

// Initial State
let isMuted = false;
let isCamOff = false;

// --- Particle Engine ---
const canvas = document.getElementById('particle-canvas');
if (canvas) {
    const ctx = canvas.getContext('2d');
    let particles = [];

    function initParticles() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        particles = [];
        for (let i = 0; i < 50; i++) {
            particles.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                size: Math.random() * 2 + 1,
                speedX: Math.random() * 0.5 - 0.25,
                speedY: Math.random() * 0.5 - 0.25,
                opacity: Math.random() * 0.5
            });
        }
    }

    function animateParticles() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => {
            p.x += p.speedX;
            p.y += p.speedY;
            if (p.x < 0 || p.x > canvas.width) p.speedX *= -1;
            if (p.y < 0 || p.y > canvas.height) p.speedY *= -1;

            ctx.fillStyle = `rgba(92, 98, 255, ${p.opacity})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
        });
        requestAnimationFrame(animateParticles);
    }

    window.addEventListener('resize', initParticles);
    initParticles();
    animateParticles();
}

// --- Socket Events ---

socket.on('update_count', (data) => {
    if (onlineCountElem) onlineCountElem.innerText = data.count;
});

socket.on('identity_assigned', (data) => {
    const localIdElem = document.getElementById('local-identity');
    if (localIdElem) localIdElem.innerText = data.identity;
});

socket.on('waiting', (data) => {
    if (searchingOverlay) {
        searchingOverlay.style.display = 'flex';
        searchingOverlay.style.alignItems = 'center';
        searchingOverlay.style.justifyContent = 'center';
    }
    remoteVideo.srcObject = null;
    addChatMessage("SYSTEM", "SEARCHING NETWORK NODES...");
});

socket.on('join_private_room', (data) => {
    roomID = data.room_id;
    socket.emit('join_room', { room_id: roomID });
    document.querySelector('.user-name').innerText = data.partner_identity;
    setupPeerConnection(false);
});

socket.on('found_partner', (data) => {
    roomID = data.room_id;
    socket.emit('join_room', { room_id: roomID });
    if (searchingOverlay) searchingOverlay.style.display = 'none';
    document.querySelector('.user-name').innerText = data.partner_identity;
    addChatMessage("SYSTEM", `STABLE LINK ESTABLISHED WITH ${data.partner_identity}.`);
    setupPeerConnection(true);
});

socket.on('partner_disconnected', () => {
    addChatMessage("SYSTEM", "REMOTE NODE DISCONNECTED.");
    document.querySelector('.user-name').innerText = "AWAY_USER";
    closePeerConnection();
    if (searchingOverlay) {
        searchingOverlay.style.display = 'flex';
        searchingOverlay.style.alignItems = 'center';
        searchingOverlay.style.justifyContent = 'center';
    }
});

socket.on('chat_message', (data) => {
    const sender = data.sender === socket.id ? "YOU" : "STRANGER";
    addChatMessage(sender, data.msg);
});

socket.on('partner_typing', (data) => {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) indicator.style.display = data.typing ? 'block' : 'none';
});

socket.on('signal', async (data) => {
    if (!peerConnection) return;
    if (data.sdp) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('signal', { sdp: answer });
        }
    } else if (data.ice) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.ice));
        } catch (e) {
            console.error("Error adding ice candidate", e);
        }
    }
});

// --- Functions ---

async function startApp() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: true
        });
        localVideo.srcObject = localStream;

        // Transition: Hide Landing, Show Dashboard
        if (landingPage) {
            landingPage.style.opacity = '0';
            setTimeout(() => {
                landingPage.style.display = 'none';
                if (appContainer) {
                    appContainer.style.display = 'grid'; // Layout defined in style.css
                }
                const statusPill = document.getElementById('status-pill');
                if (statusPill) statusPill.style.display = 'flex';
                findPartner();
            }, 500);
        }

    } catch (err) {
        alert("CRITICAL ERROR: Camera and Microphone access are mandatory.");
        console.error(err);
    }
}

function findPartner() {
    closePeerConnection();
    socket.emit('find_partner');
}

function setupPeerConnection(isInitiator) {
    peerConnection = new RTCPeerConnection(config);

    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    peerConnection.ontrack = (event) => {
        if (!remoteStream) {
            remoteStream = new MediaStream();
            remoteVideo.srcObject = remoteStream;
        }
        remoteStream.addTrack(event.track);
        searchingOverlay.style.display = 'none';
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', { ice: event.candidate });
        }
    };

    if (isInitiator) {
        peerConnection.onnegotiationneeded = async () => {
            try {
                const offer = await peerConnection.createOffer();
                await peerConnection.setLocalDescription(offer);
                socket.emit('signal', { sdp: offer });
            } catch (err) {
                console.error(err);
            }
        };
    }
}

function closePeerConnection() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (remoteVideo) remoteVideo.srcObject = null;
    remoteStream = null;
    if (searchingOverlay) searchingOverlay.style.display = 'flex';
}

function addChatMessage(sender, msg) {
    const div = document.createElement('div');
    if (sender === "SYSTEM") {
        div.className = 'system-log';
        div.innerText = msg;
    } else {
        div.className = `msg ${sender === "YOU" ? 'sent' : 'received'}`;
        div.innerText = msg;
    }
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function sendMessage() {
    const msg = chatInput.value.trim();
    if (msg) {
        if (roomID) {
            socket.emit('chat_message', { msg: msg });
            chatInput.value = '';
        } else {
            addChatMessage("SYSTEM", "NO ACTIVE NODE DETECTED. TRANSMISSION ABORTED.");
        }
    }
}

// --- Event Listeners ---

if (startBtn) startBtn.addEventListener('click', startApp);

if (nextBtn) {
    nextBtn.addEventListener('click', () => {
        addChatMessage("SYSTEM", "RE-ROUTING TO NEXT AVAILABLE NODE...");
        findPartner();
    });
}

if (sendBtn) sendBtn.addEventListener('click', sendMessage);
if (chatInput) {
    let typingTimeout;
    chatInput.addEventListener('input', () => {
        socket.emit('typing', { typing: true });
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            socket.emit('typing', { typing: false });
        }, 2000);
    });

    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendMessage();
            socket.emit('typing', { typing: false });
        }
    });
}

const toggleMic = document.getElementById('toggle-mic');
if (toggleMic) {
    toggleMic.addEventListener('click', (e) => {
        isMuted = !isMuted;
        localStream.getAudioTracks()[0].enabled = !isMuted;
        e.currentTarget.innerHTML = isMuted ? '<i class="fas fa-microphone-slash"></i>' : '<i class="fas fa-microphone"></i>';
        e.currentTarget.style.background = isMuted ? 'var(--accent)' : '';
    });
}

const toggleCam = document.getElementById('toggle-cam');
if (toggleCam) {
    toggleCam.addEventListener('click', (e) => {
        isCamOff = !isCamOff;
        localStream.getVideoTracks()[0].enabled = !isCamOff;
        e.currentTarget.innerHTML = isCamOff ? '<i class="fas fa-video-slash"></i>' : '<i class="fas fa-video"></i>';
        e.currentTarget.style.background = isCamOff ? 'var(--accent)' : '';
    });
}

if (reportBtn) {
    reportBtn.addEventListener('click', () => {
        reportModal.style.display = 'flex';
    });
}

const cancelReport = document.getElementById('cancel-report');
if (cancelReport) {
    cancelReport.addEventListener('click', () => {
        reportModal.style.display = 'none';
    });
}

const reportOptionsNodeList = document.querySelectorAll('.report-option');
reportOptionsNodeList.forEach(opt => {
    opt.addEventListener('click', (e) => {
        const reason = e.target.value;
        socket.emit('report_user', { reason: reason });
        reportModal.style.display = 'none';
        addChatMessage("SYSTEM", `REPORT LOGGED: ${reason.toUpperCase()}. SHIFTING NODES...`);
        findPartner();
    });
});

// Video Filters Logic
const filters = ['filter-none', 'filter-grayscale', 'filter-sepia', 'filter-invert', 'filter-cyber', 'filter-warm'];
let currentFilterIndex = 0;

const cycleFiltersBtn = document.getElementById('cycle-filters');
if (cycleFiltersBtn) {
    cycleFiltersBtn.addEventListener('click', () => {
        currentFilterIndex = (currentFilterIndex + 1) % filters.length;
        const newFilter = filters[currentFilterIndex];

        // Apply to local video
        localVideo.className = '';
        localVideo.classList.add(newFilter);

        // Show subtle notification in logs
        addChatMessage("SYSTEM", `FX PROFILE UPDATED: ${newFilter.replace('filter-', '').toUpperCase()}`);

        // Visual feedback on button
        cycleFiltersBtn.style.color = currentFilterIndex === 0 ? 'white' : 'var(--primary)';
    });
}
const signalIcon = document.querySelector('.connection-quality i');
if (signalIcon) {
    setInterval(() => {
        const qualities = ['fa-signal', 'fa-signal', 'fa-signal', 'fa-signal-bars']; // Use FontAwesome signal states
        // Since I only have fa-signal, I'll fluctuate opacity or color
        const opacity = 0.4 + Math.random() * 0.6;
        signalIcon.style.opacity = opacity;
    }, 1000);
}
// Matching Logic Interactivity
const matchingBtns = document.querySelectorAll('.side-panel.left .pref-btn');
matchingBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        matchingBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.querySelector('span').innerText;
        addChatMessage("SYSTEM", `MATCHING LOGIC UPDATED: ${mode.toUpperCase()}`);

        // Visual feedback
        btn.style.transform = 'scale(0.95)';
        setTimeout(() => btn.style.transform = 'scale(1)', 100);

        // If we change logic, maybe find a new partner?
        if (roomID) {
            addChatMessage("SYSTEM", "ADAPTING TO NEW LOGIC PARAMETERS...");
        }
    });
});

// Interest Tags Interactivity
const interestTags = document.querySelectorAll('.tag');
interestTags.forEach(tag => {
    tag.addEventListener('click', () => {
        tag.classList.toggle('active');
        const interest = tag.innerText;
        const isActive = tag.classList.contains('active');

        if (isActive) {
            addChatMessage("SYSTEM", `INTEREST FILTER ADDED: ${interest.toUpperCase()}`);
        } else {
            addChatMessage("SYSTEM", `INTEREST FILTER REMOVED: ${interest.toUpperCase()}`);
        }

        // Logic to send interests to backend if needed
        socket.emit('update_interests', {
            interests: Array.from(document.querySelectorAll('.tag.active')).map(t => t.innerText)
        });
    });
});

const emojiBtns = document.querySelectorAll('.emoji-btn');
emojiBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const emoji = btn.innerText;
        if (roomID) {
            socket.emit('chat_message', { msg: emoji });
            // Add a temporary pop animation
            btn.style.transform = 'scale(1.5)';
            setTimeout(() => btn.style.transform = 'scale(1)', 200);
        } else {
            addChatMessage("SYSTEM", "ESTABLISH UPLINK BEFORE TRANSMITTING.");
        }
    });
});
