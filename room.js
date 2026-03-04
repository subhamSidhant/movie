/**
 * StreamFlow Room
 * WebRTC mesh networking + synchronized video playback
 */

// ─── URL Params ───────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const MY_CODE = params.get('code') || '';
const MY_PEER_ID = params.get('peerId') || '';
const MY_NAME = params.get('name') || 'Anonymous';
const IS_HOST = params.get('host') === 'true';
const INITIAL_PEERS = JSON.parse(decodeURIComponent(params.get('peers') || '[]'));

const WS_URL = (window.SF_CONFIG && window.SF_CONFIG.wsUrl)
    || `ws://${location.hostname}:${location.port || 4000}`;

// ─── State ────────────────────────────────────────────────────────
let ws = null;
let localStream = null;
let isMicMuted = false;
let isCamOff = false;

// peers: Map<peerId, { pc: RTCPeerConnection, stream: MediaStream|null, name: string }>
const peers = new Map();

// Video player state
let videoLoaded = false;
let isSyncLeader = IS_HOST; // host starts as sync leader
let ignoreSyncUntil = 0;     // ignore incoming syncs briefly after local action

const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// ─── DOM ─────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const roomCodeChip = $('roomCodeChip');
const roomCodeDisplay = $('roomCodeDisplay');
const countLabel = $('countLabel');
const participantsGrid = $('participantsGrid');
const leaveBtn = $('leaveBtn');
const micBtn = $('micBtn');
const camBtn = $('camBtn');
const toastEl = $('toast');
const permModal = $('permModal');

// Player
const videoUrlBar = $('videoUrlBar');
const sharedVideoUrl = $('sharedVideoUrl');
const streamBtn = $('streamBtn');
const playerWrap = $('playerWrap');
const playerEmpty = $('playerEmpty');
const playerLoading = $('playerLoading');
const playerControls = $('playerControls');
const sharedPlayer = $('sharedPlayer');
const progressWrap = $('progressWrap');
const progressBuf = $('progressBuf');
const progressPlayed = $('progressPlayed');
const progressThumb = $('progressThumb');
const progressTip = $('progressTip');
const playBtn = $('playBtn');
const skipBackBtn = $('skipBackBtn');
const skipFwdBtn = $('skipFwdBtn');
const volBtn = $('volBtn');
const volSlider = $('volSlider');
const curTime = $('curTime');
const durDisplay = $('durDisplay');
const syncBadge = $('syncBadge');
const speedBtn = $('speedBtn');
const speedMenu = $('speedMenu');
const speedVal = $('speedVal');
const fsBtn = $('fsBtn');

// ─── Toast ────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = '') {
    clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = `toast ${type} show`;
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

// ─── Room Code ───────────────────────────────────────────────────
roomCodeDisplay.textContent = MY_CODE;
roomCodeChip.addEventListener('click', () => {
    navigator.clipboard.writeText(MY_CODE).then(() => showToast('Code copied!', 'success'));
});

// ─── Count ───────────────────────────────────────────────────────
function updateCount() {
    const total = peers.size + 1;
    countLabel.textContent = `${total} in room`;
}
updateCount();

// ─── Participant Tile Rendering ───────────────────────────────────
function createTile(peerId, name, stream, isLocal = false) {
    const tile = document.createElement('div');
    tile.className = `peer-tile${isLocal ? '' : ' remote'}`;
    tile.id = `tile-${peerId}`;

    // Camera placeholder shown when no stream / cam off
    const placeholder = document.createElement('div');
    placeholder.className = 'cam-placeholder';
    placeholder.innerHTML = `
        <div class="avatar">${name.charAt(0).toUpperCase()}</div>
        <span class="cam-name">${name}${isLocal ? ' (You)' : ''}</span>
    `;

    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = isLocal; // mute local to prevent echo
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.style.display = 'none'; // hidden until stream is live

    const overlay = document.createElement('div');
    overlay.className = 'tile-overlay';
    overlay.innerHTML = `<span class="tile-name">${name}${isLocal ? ' (You)' : ''}</span>`;

    const icons = document.createElement('div');
    icons.className = 'tile-icons';

    tile.appendChild(placeholder);
    tile.appendChild(video);
    tile.appendChild(overlay);
    tile.appendChild(icons);

    if (stream) {
        setVideoStream(video, placeholder, stream);
    }

    participantsGrid.appendChild(tile);
    return tile;
}

function setVideoStream(video, placeholder, stream) {
    video.srcObject = stream;
    // Show video once it starts playing; hide placeholder
    video.onloadedmetadata = () => {
        video.play().catch(() => { });
    };
    video.onplaying = () => {
        video.style.display = 'block';
        placeholder.style.display = 'none';
    };
    // Fallback: show video after short delay even if 'playing' doesn't fire
    setTimeout(() => {
        if (video.srcObject && video.readyState >= 2) {
            video.style.display = 'block';
            placeholder.style.display = 'none';
        }
    }, 1200);
}

function removeTile(peerId) {
    const tile = document.getElementById(`tile-${peerId}`);
    if (tile) tile.remove();
}

function updateTileStream(peerId, stream) {
    const tile = document.getElementById(`tile-${peerId}`);
    if (!tile) return;
    const video = tile.querySelector('video');
    const placeholder = tile.querySelector('.cam-placeholder');
    if (stream && stream.getVideoTracks().length > 0) {
        setVideoStream(video, placeholder, stream);
    } else {
        video.style.display = 'none';
        placeholder.style.display = 'flex';
    }
}


function updateTileState(peerId, audioMuted, videoOff) {
    const tile = $(`tile-${peerId}`);
    if (!tile) return;
    const icons = tile.querySelector('.tile-icons');
    icons.innerHTML = '';

    if (audioMuted) {
        const icon = document.createElement('div');
        icon.className = 'tile-icon';
        icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/><path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23M12 19v3M8 23h8"/></svg>`;
        icons.appendChild(icon);
    }

    if (videoOff) {
        const icon = document.createElement('div');
        icon.className = 'tile-icon';
        icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M16 16l7 4V7.5M1 1l22 22M11 5H3a2 2 0 00-2 2v10"/></svg>`;
        icons.appendChild(icon);

        const placeholder = tile.querySelector('.cam-placeholder');
        if (placeholder) placeholder.style.display = 'flex';
        const video = tile.querySelector('video');
        if (video) video.style.display = 'none';
    } else {
        const video = tile.querySelector('video');
        if (video && video.srcObject) {
            video.style.display = '';
            const placeholder = tile.querySelector('.cam-placeholder');
            if (placeholder) placeholder.style.display = 'none';
        }
    }
}

// ─── Media ───────────────────────────────────────────────────────
async function startMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        return true;
    } catch (err) {
        console.warn('Media access denied:', err.message);
        localStream = null;
        return false;
    }
}

function broadcastState() {
    if (!ws) return;
    ws.send(JSON.stringify({
        type: 'peer-state',
        audioMuted: isMicMuted,
        videoOff: isCamOff
    }));
}

// ─── Mic / Cam Toggles ───────────────────────────────────────────
micBtn.addEventListener('click', () => {
    isMicMuted = !isMicMuted;
    if (localStream) {
        localStream.getAudioTracks().forEach(t => t.enabled = !isMicMuted);
    }
    micBtn.classList.toggle('active', isMicMuted);
    micBtn.querySelector('.icon-mic').style.display = isMicMuted ? 'none' : '';
    micBtn.querySelector('.icon-mic-off').style.display = isMicMuted ? '' : 'none';
    micBtn.querySelector('span').textContent = isMicMuted ? 'Unmute' : 'Mute';
    broadcastState();
});

camBtn.addEventListener('click', () => {
    isCamOff = !isCamOff;
    if (localStream) {
        localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
    }
    camBtn.classList.toggle('active', isCamOff);
    camBtn.querySelector('.icon-cam').style.display = isCamOff ? 'none' : '';
    camBtn.querySelector('.icon-cam-off').style.display = isCamOff ? '' : 'none';
    camBtn.querySelector('span').textContent = isCamOff ? 'Cam On' : 'Cam Off';
    // Update own tile
    updateTileState(MY_PEER_ID, isMicMuted, isCamOff);
    broadcastState();
});

// ─── WebRTC Peer Connection ───────────────────────────────────────
function createPeerConnection(peerId) {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    // Add local tracks
    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    // Receive remote tracks
    pc.ontrack = (e) => {
        const stream = e.streams[0];
        const peer = peers.get(peerId);
        if (peer) {
            peer.stream = stream;
            updateTileStream(peerId, stream);
        }
    };

    // ICE candidates
    pc.onicecandidate = (e) => {
        if (e.candidate && ws) {
            ws.send(JSON.stringify({
                type: 'ice-candidate',
                targetPeerId: peerId,
                candidate: e.candidate
            }));
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`[WebRTC] ${peerId}: ${pc.connectionState}`);
    };

    return pc;
}

async function initiateCall(peerId) {
    const pc = createPeerConnection(peerId);
    peers.get(peerId).pc = pc;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    ws.send(JSON.stringify({
        type: 'offer',
        targetPeerId: peerId,
        offer: pc.localDescription
    }));
}

// ─── WebSocket ───────────────────────────────────────────────────
function connectSignaling() {
    ws = new WebSocket(WS_URL);

    ws.onopen = async () => {
        console.log('[WS] Connected');
        // Re-announce ourselves to the room
        // (We already joined via lobby, so just send our state)
        broadcastState();

        // Initiate calls to existing peers (as the new joiner)
        for (const { peerId, name } of INITIAL_PEERS) {
            if (peerId === MY_PEER_ID) continue;
            peers.set(peerId, { pc: null, stream: null, name });
            createTile(peerId, name, null);
            await initiateCall(peerId);
        }
        updateCount();
    };

    ws.onmessage = async (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        switch (msg.type) {
            // ── New peer joined ──
            case 'peer-joined': {
                const { peerId, name } = msg;
                if (peerId === MY_PEER_ID) return;
                peers.set(peerId, { pc: null, stream: null, name });
                createTile(peerId, name, null);
                updateCount();
                showToast(`${name} joined the room`);

                // Existing members answer (new joiner sends offer first)
                // So we wait for their offer - don't initiate here
                break;
            }

            // ── Peer left ──
            case 'peer-left': {
                const { peerId } = msg;
                const peer = peers.get(peerId);
                if (peer) {
                    peer.pc && peer.pc.close();
                    peers.delete(peerId);
                    removeTile(peerId);
                    updateCount();
                    showToast(`${peer.name} left the room`);
                }
                break;
            }

            // ── WebRTC: Offer received ──
            case 'offer': {
                const { fromPeerId, offer } = msg;
                let peerEntry = peers.get(fromPeerId);
                if (!peerEntry) {
                    peerEntry = { pc: null, stream: null, name: 'Guest' };
                    peers.set(fromPeerId, peerEntry);
                    createTile(fromPeerId, peerEntry.name, null);
                    updateCount();
                }

                const pc = createPeerConnection(fromPeerId);
                peerEntry.pc = pc;

                await pc.setRemoteDescription(new RTCSessionDescription(offer));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);

                ws.send(JSON.stringify({
                    type: 'answer',
                    targetPeerId: fromPeerId,
                    answer: pc.localDescription
                }));
                break;
            }

            // ── WebRTC: Answer received ──
            case 'answer': {
                const { fromPeerId, answer } = msg;
                const peer = peers.get(fromPeerId);
                if (peer && peer.pc) {
                    await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
                }
                break;
            }

            // ── WebRTC: ICE candidate ──
            case 'ice-candidate': {
                const { fromPeerId, candidate } = msg;
                const peer = peers.get(fromPeerId);
                if (peer && peer.pc && candidate) {
                    try { await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)); }
                    catch (err) { console.warn('ICE candidate error:', err); }
                }
                break;
            }

            // ── Video sync ──
            case 'video-sync': {
                if (Date.now() < ignoreSyncUntil) return;
                handleRemoteSync(msg);
                break;
            }

            // ── Peer state updates (mute/cam) ──
            case 'peer-state': {
                const { peerId, audioMuted, videoOff } = msg;
                updateTileState(peerId, audioMuted, videoOff);
                break;
            }
        }
    };

    ws.onclose = () => { console.log('[WS] Disconnected'); };
    ws.onerror = (e) => { console.error('[WS] Error', e); };
}

// ─── Video Sync ───────────────────────────────────────────────────
function sendSync(action, extraData = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ignoreSyncUntil = Date.now() + 800; // don't echo our own action
    ws.send(JSON.stringify({ type: 'video-sync', action, time: sharedPlayer.currentTime, ...extraData }));
}

function handleRemoteSync(msg) {
    const { action, time, src } = msg;

    switch (action) {
        case 'load':
            if (src) loadVideo(src, false);
            break;
        case 'play':
            if (Math.abs(sharedPlayer.currentTime - time) > 1.5) sharedPlayer.currentTime = time;
            sharedPlayer.play().catch(() => { });
            showSyncBadge();
            break;
        case 'pause':
            sharedPlayer.currentTime = time;
            sharedPlayer.pause();
            showSyncBadge();
            break;
        case 'seek':
            sharedPlayer.currentTime = time;
            showSyncBadge();
            break;
    }
}

function showSyncBadge() {
    syncBadge.style.display = 'flex';
    clearTimeout(showSyncBadge._timer);
    showSyncBadge._timer = setTimeout(() => syncBadge.style.display = 'none', 2000);
}

// ─── Video Player ─────────────────────────────────────────────────
function loadVideo(src, broadcast = true) {
    playerEmpty.style.display = 'none';
    playerLoading.style.display = 'flex';
    sharedPlayer.style.display = '';
    playerControls.style.display = '';
    sharedVideoUrl.value = src;

    sharedPlayer.src = src;
    sharedPlayer.load();

    if (broadcast) sendSync('load', { src });
    videoLoaded = true;
}

streamBtn.addEventListener('click', () => {
    const src = sharedVideoUrl.value.trim();
    if (!src) { sharedVideoUrl.focus(); return; }
    loadVideo(src, true);
});
sharedVideoUrl.addEventListener('keypress', e => e.key === 'Enter' && streamBtn.click());

// Player events
sharedPlayer.addEventListener('loadedmetadata', () => {
    playerLoading.style.display = 'none';
    durDisplay.textContent = formatTime(sharedPlayer.duration);
});
sharedPlayer.addEventListener('waiting', () => playerLoading.style.display = 'flex');
sharedPlayer.addEventListener('playing', () => playerLoading.style.display = 'none');

sharedPlayer.addEventListener('timeupdate', () => {
    if (!sharedPlayer.duration) return;
    const pct = (sharedPlayer.currentTime / sharedPlayer.duration) * 100;
    progressPlayed.style.width = `${pct}%`;
    progressThumb.style.left = `${pct}%`;
    curTime.textContent = formatTime(sharedPlayer.currentTime);

    // Update buffer
    if (sharedPlayer.buffered.length) {
        const bufEnd = sharedPlayer.buffered.end(sharedPlayer.buffered.length - 1);
        progressBuf.style.width = `${(bufEnd / sharedPlayer.duration) * 100}%`;
    }
});

sharedPlayer.addEventListener('play', () => {
    playBtn.querySelector('.icon-play').style.display = 'none';
    playBtn.querySelector('.icon-pause').style.display = '';
    sendSync('play');
});
sharedPlayer.addEventListener('pause', () => {
    playBtn.querySelector('.icon-play').style.display = '';
    playBtn.querySelector('.icon-pause').style.display = 'none';
    sendSync('pause');
});

// Progress bar seeking
let isDragging = false;
function seekFromEvent(e) {
    const rect = progressWrap.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    sharedPlayer.currentTime = pct * sharedPlayer.duration;
    sendSync('seek');
}
progressWrap.addEventListener('mousedown', e => { isDragging = true; seekFromEvent(e); });
document.addEventListener('mousemove', e => { if (isDragging) seekFromEvent(e); });
document.addEventListener('mouseup', () => isDragging = false);
progressWrap.addEventListener('mousemove', e => {
    const rect = progressWrap.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (sharedPlayer.duration) {
        progressTip.textContent = formatTime(pct * sharedPlayer.duration);
        progressTip.style.left = `${pct * 100}%`;
    }
});

// Controls
playBtn.addEventListener('click', () => sharedPlayer.paused ? sharedPlayer.play() : sharedPlayer.pause());
skipBackBtn.addEventListener('click', () => { sharedPlayer.currentTime = Math.max(0, sharedPlayer.currentTime - 10); sendSync('seek'); });
skipFwdBtn.addEventListener('click', () => { sharedPlayer.currentTime = Math.min(sharedPlayer.duration, sharedPlayer.currentTime + 10); sendSync('seek'); });

volBtn.addEventListener('click', () => {
    sharedPlayer.muted = !sharedPlayer.muted;
    volBtn.querySelector('.icon-vol').style.display = sharedPlayer.muted ? 'none' : '';
    volBtn.querySelector('.icon-vol-mute').style.display = sharedPlayer.muted ? '' : 'none';
});
volSlider.addEventListener('input', e => {
    sharedPlayer.volume = e.target.value;
    sharedPlayer.muted = e.target.value == 0;
});

// Speed
speedBtn.addEventListener('click', e => { e.stopPropagation(); speedMenu.classList.toggle('open'); });
document.addEventListener('click', () => speedMenu.classList.remove('open'));
speedMenu.querySelectorAll('[data-speed]').forEach(btn => {
    btn.addEventListener('click', e => {
        e.stopPropagation();
        const s = parseFloat(btn.dataset.speed);
        sharedPlayer.playbackRate = s;
        speedVal.textContent = `${s}×`;
        speedMenu.querySelectorAll('[data-speed]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        speedMenu.classList.remove('open');
    });
});

// Fullscreen
fsBtn.addEventListener('click', toggleFullscreen);
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        playerWrap.requestFullscreen().catch(() => { });
        playerWrap.classList.add('is-fullscreen');
    } else {
        document.exitFullscreen();
        playerWrap.classList.remove('is-fullscreen');
    }
}
document.addEventListener('fullscreenchange', () => {
    const inFs = !!document.fullscreenElement;
    fsBtn.querySelector('.icon-expand').style.display = inFs ? 'none' : '';
    fsBtn.querySelector('.icon-compress').style.display = inFs ? '' : 'none';
});

// Keyboard
document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key) {
        case ' ': case 'k': e.preventDefault(); sharedPlayer.paused ? sharedPlayer.play() : sharedPlayer.pause(); break;
        case 'ArrowLeft': e.preventDefault(); sharedPlayer.currentTime -= 10; sendSync('seek'); break;
        case 'ArrowRight': e.preventDefault(); sharedPlayer.currentTime += 10; sendSync('seek'); break;
        case 'f': case 'F': toggleFullscreen(); break;
        case 'm': case 'M': sharedPlayer.muted = !sharedPlayer.muted; break;
    }
});

// ─── Leave ───────────────────────────────────────────────────────
leaveBtn.addEventListener('click', () => {
    if (ws) ws.send(JSON.stringify({ type: 'leave-room' }));
    localStream && localStream.getTracks().forEach(t => t.stop());
    peers.forEach(p => p.pc && p.pc.close());
    window.location.href = '/lobby.html';
});

// ─── Permission Modal ─────────────────────────────────────────────
$('permAllow').addEventListener('click', async () => {
    permModal.style.display = 'none';
    await startMedia();
    bootstrap();
});
$('permSkip').addEventListener('click', () => {
    permModal.style.display = 'none';
    localStream = null;
    bootstrap();
});

// ─── Bootstrap ───────────────────────────────────────────────────
async function bootstrap() {
    // Show local tile
    createTile(MY_PEER_ID, MY_NAME, localStream, true);
    updateCount();

    // Connect signaling
    connectSignaling();

    // If we're entering an existing room as host (no initial peers array needed)
    if (IS_HOST) {
        showToast(`Room created! Code: ${MY_CODE}`, 'success');
    }
}

function formatTime(s) {
    if (isNaN(s) || !isFinite(s)) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
}

// ─── Init ─────────────────────────────────────────────────────────
if (!MY_CODE || !MY_PEER_ID) {
    // Invalid state — send back to lobby
    window.location.href = '/lobby.html';
} else {
    // Show permission modal first
    permModal.style.display = 'flex';
}
