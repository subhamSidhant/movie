/**
 * StreamFlow — Signaling Server (standalone)
 * Deploy this on Render, Railway, or Fly.io
 * It only handles WebSocket room signaling (no static file serving)
 *
 * ▶  Local:   node signaling-server.js
 * ▶  Render:  set Start Command to "node signaling-server.js"
 */

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3001;

// ─── Room State ─────────────────────────────
const rooms = new Map();

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return rooms.has(code) ? generateRoomCode() : code;
}

function generatePeerId() {
    return Math.random().toString(36).substr(2, 9);
}

// ─── HTTP (health check for Render) ─────────
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
});

// ─── WebSocket ───────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    ws.peerId = generatePeerId();
    ws.roomCode = null;
    ws.name = 'Anonymous';

    ws.sendJSON = (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    };

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {
            case 'create-room': {
                const code = generateRoomCode();
                ws.roomCode = code;
                ws.name = msg.name || 'Host';
                rooms.set(code, { members: new Map([[ws.peerId, ws]]) });
                ws.sendJSON({ type: 'room-created', code, peerId: ws.peerId });
                console.log(`🏠 Room: ${code} — ${ws.name}`);
                break;
            }

            case 'join-room': {
                const { code, name } = msg;
                if (!rooms.has(code)) {
                    ws.sendJSON({ type: 'error', message: 'Room not found. Check the code and try again.' });
                    return;
                }
                const room = rooms.get(code);
                ws.roomCode = code;
                ws.name = name || 'Guest';

                const existingPeers = [];
                room.members.forEach((mWs, pid) => existingPeers.push({ peerId: pid, name: mWs.name }));

                ws.sendJSON({ type: 'room-joined', code, peerId: ws.peerId, peers: existingPeers });
                room.members.forEach((mWs) => mWs.sendJSON({ type: 'peer-joined', peerId: ws.peerId, name: ws.name }));
                room.members.set(ws.peerId, ws);
                console.log(`👤 ${ws.name} → ${code} (${room.members.size})`);
                break;
            }

            case 'offer':
            case 'answer':
            case 'ice-candidate': {
                const { targetPeerId, ...payload } = msg;
                const room = rooms.get(ws.roomCode);
                if (!room) return;
                const target = room.members.get(targetPeerId);
                if (target) target.sendJSON({ ...payload, fromPeerId: ws.peerId });
                break;
            }

            case 'video-sync': {
                const room = rooms.get(ws.roomCode);
                if (!room) return;
                room.members.forEach((mWs, pid) => {
                    if (pid !== ws.peerId)
                        mWs.sendJSON({ type: 'video-sync', action: msg.action, time: msg.time, src: msg.src });
                });
                break;
            }

            case 'peer-state': {
                const room = rooms.get(ws.roomCode);
                if (!room) return;
                room.members.forEach((mWs, pid) => {
                    if (pid !== ws.peerId)
                        mWs.sendJSON({ type: 'peer-state', peerId: ws.peerId, audioMuted: msg.audioMuted, videoOff: msg.videoOff });
                });
                break;
            }

            case 'leave-room':
                handleDisconnect(ws);
                break;
        }
    });

    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', (err) => console.error('WS error:', err.message));
});

function handleDisconnect(ws) {
    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    room.members.delete(ws.peerId);
    console.log(`👋 ${ws.name} left ${ws.roomCode} (${room.members.size} left)`);

    room.members.forEach((mWs) => mWs.sendJSON({ type: 'peer-left', peerId: ws.peerId }));

    if (room.members.size === 0) {
        rooms.delete(ws.roomCode);
        console.log(`🗑️  Room ${ws.roomCode} removed`);
    }
    ws.roomCode = null;
}

server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║  🔌 StreamFlow Signaling Server              ║
║  Port: ${PORT}                                   ║
║  Health: http://localhost:${PORT}/             ║
║  WebSocket: ws://localhost:${PORT}            ║
╚══════════════════════════════════════════════╝
    `);
});
