/**
 * StreamFlow Lobby
 * Handles room creation and joining via WebSocket signaling
 */

const WS_URL = (window.SF_CONFIG && window.SF_CONFIG.wsUrl)
    || `ws://${location.hostname}:${location.port || 4000}`;
let ws = null;
let pendingAction = null; // 'create' | 'join'

// ── DOM ───────────────────────────────────────────────────────────
const createNameInput = document.getElementById('createName');
const joinNameInput = document.getElementById('joinName');
const roomCodeInput = document.getElementById('roomCode');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const toastEl = document.getElementById('toast');

let toastTimer = null;
function showToast(msg, type = '') {
    clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = `toast ${type} show`;
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3500);
}

// ── WebSocket ─────────────────────────────────────────────────────
function connect(onOpen) {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        onOpen && onOpen();
    };

    ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        switch (msg.type) {
            case 'room-created':
                // Redirect to room page as host
                window.location.href = `/room.html?code=${msg.code}&peerId=${msg.peerId}&name=${encodeURIComponent(
                    createNameInput.value.trim() || 'Host'
                )}&host=true`;
                break;

            case 'room-joined':
                // Redirect to room page as member
                window.location.href = `/room.html?code=${msg.code}&peerId=${msg.peerId}&name=${encodeURIComponent(
                    joinNameInput.value.trim() || 'Guest'
                )}&peers=${encodeURIComponent(JSON.stringify(msg.peers))}`;
                break;

            case 'error':
                showToast(msg.message, 'error');
                setLoading(false);
                break;
        }
    };

    ws.onerror = () => {
        showToast('Cannot connect to server. Is it running?', 'error');
        setLoading(false);
    };

    ws.onclose = () => {
        // Connection closed before redirect — noop
    };
}

function setLoading(state) {
    createBtn.disabled = state;
    joinBtn.disabled = state;
    if (!state) {
        createBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg> Create Room`;
        joinBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Join Room`;
    }
}

// ── Actions ───────────────────────────────────────────────────────
createBtn.addEventListener('click', () => {
    const name = createNameInput.value.trim();
    if (!name) { createNameInput.focus(); showToast('Please enter your name', 'error'); return; }

    setLoading(true);
    createBtn.textContent = 'Creating…';
    connect(() => {
        ws.send(JSON.stringify({ type: 'create-room', name }));
    });
});

joinBtn.addEventListener('click', () => {
    const name = joinNameInput.value.trim();
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!name) { joinNameInput.focus(); showToast('Please enter your name', 'error'); return; }
    if (code.length !== 6) { roomCodeInput.focus(); showToast('Enter the 6-digit room code', 'error'); return; }

    setLoading(true);
    joinBtn.textContent = 'Joining…';
    connect(() => {
        ws.send(JSON.stringify({ type: 'join-room', code, name }));
    });
});

// Auto-uppercase room code input
roomCodeInput.addEventListener('input', (e) => {
    const pos = e.target.selectionStart;
    e.target.value = e.target.value.toUpperCase();
    e.target.setSelectionRange(pos, pos);
});

// Enter key support
createNameInput.addEventListener('keypress', e => e.key === 'Enter' && createBtn.click());
roomCodeInput.addEventListener('keypress', e => e.key === 'Enter' && joinBtn.click());
joinNameInput.addEventListener('keypress', e => e.key === 'Enter' && joinBtn.click());

// Focus first input
createNameInput.focus();
