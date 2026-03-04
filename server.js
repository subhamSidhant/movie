/**
 * StreamFlow Server
 * - HTTP: Serves static files + video proxy (CORS bypass)
 * - WebSocket: Room signaling for WebRTC + video sync
 */

const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');
const fs = require('fs');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = 4000;

// MIME types
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// ─── Room State ────────────────────────────────────────────────────────────────
// rooms: Map<roomCode, { members: Map<peerId, { ws, name, socketId }> }>
const rooms = new Map();

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return rooms.has(code) ? generateRoomCode() : code;
}

function generatePeerId() {
    return Math.random().toString(36).substr(2, 9);
}

// ─── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    // Video proxy endpoint
    if (pathname === '/proxy') {
        const videoUrl = parsedUrl.query.url;
        if (!videoUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing url parameter' }));
            return;
        }
        console.log(`\n🎬 Proxying: ${videoUrl}`);
        try {
            await proxyVideo(videoUrl, req, res);
        } catch (error) {
            console.error('❌ Proxy error:', error.message);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
        }
        return;
    }

    // Static files — default to lobby.html
    let filePath = pathname === '/' ? '/lobby.html' : pathname;
    filePath = path.join(__dirname, filePath);

    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') { res.writeHead(404); res.end('File not found'); }
            else { res.writeHead(500); res.end('Server error'); }
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

// ─── Video Proxy ───────────────────────────────────────────────────────────────
function proxyVideo(videoUrl, clientReq, clientRes) {
    return new Promise((resolve, reject) => {
        const parsedUrl = url.parse(videoUrl);
        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Encoding': 'identity',
            'Connection': 'keep-alive',
            'Referer': `${parsedUrl.protocol}//${parsedUrl.hostname}/`
        };
        if (clientReq.headers.range) {
            headers['Range'] = clientReq.headers.range;
        }

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.path,
            method: clientReq.method || 'GET',
            headers,
            timeout: 30000
        };

        const proxyReq = protocol.request(options, (proxyRes) => {
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                let redirectUrl = proxyRes.headers.location;
                if (redirectUrl.startsWith('/')) {
                    redirectUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}${redirectUrl}`;
                }
                proxyVideo(redirectUrl, clientReq, clientRes).then(resolve).catch(reject);
                return;
            }

            const responseHeaders = {
                'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache'
            };
            if (proxyRes.headers['content-length']) responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
            if (proxyRes.headers['content-range']) responseHeaders['Content-Range'] = proxyRes.headers['content-range'];

            if (!clientRes.headersSent) clientRes.writeHead(proxyRes.statusCode, responseHeaders);
            proxyRes.pipe(clientRes);
            proxyRes.on('end', () => { console.log('✅ Done'); resolve(); });
            proxyRes.on('error', (err) => {
                if (!clientRes.headersSent) reject(err);
                else resolve();
            });
        });

        proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('Request timeout')); });
        proxyReq.on('error', reject);
        clientReq.on('close', () => proxyReq.destroy());
        clientRes.on('close', () => proxyReq.destroy());
        proxyReq.end();
    });
}

// ─── WebSocket Signaling ───────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    ws.peerId = generatePeerId();
    ws.roomCode = null;
    ws.name = 'Anonymous';

    ws.sendJSON = (data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
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
                console.log(`🏠 Room created: ${code} by ${ws.name}`);
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

                // Tell the joiner about all existing peers
                const existingPeers = [];
                room.members.forEach((memberWs, pid) => {
                    existingPeers.push({ peerId: pid, name: memberWs.name });
                });
                ws.sendJSON({ type: 'room-joined', code, peerId: ws.peerId, peers: existingPeers });

                // Tell all existing members about the new joiner
                room.members.forEach((memberWs) => {
                    memberWs.sendJSON({ type: 'peer-joined', peerId: ws.peerId, name: ws.name });
                });

                room.members.set(ws.peerId, ws);
                console.log(`👤 ${ws.name} joined room ${code} (${room.members.size} members)`);
                break;
            }

            // WebRTC signaling relay
            case 'offer':
            case 'answer':
            case 'ice-candidate': {
                const { targetPeerId, ...payload } = msg;
                const room = rooms.get(ws.roomCode);
                if (!room) return;
                const target = room.members.get(targetPeerId);
                if (target) {
                    target.sendJSON({ ...payload, fromPeerId: ws.peerId });
                }
                break;
            }

            // Video sync relay — broadcast to whole room except sender
            case 'video-sync': {
                const room = rooms.get(ws.roomCode);
                if (!room) return;
                room.members.forEach((memberWs, pid) => {
                    if (pid !== ws.peerId) {
                        memberWs.sendJSON({ type: 'video-sync', action: msg.action, time: msg.time, src: msg.src });
                    }
                });
                break;
            }

            // Peer state changes (mute/camera) — broadcast to room
            case 'peer-state': {
                const room = rooms.get(ws.roomCode);
                if (!room) return;
                room.members.forEach((memberWs, pid) => {
                    if (pid !== ws.peerId) {
                        memberWs.sendJSON({ type: 'peer-state', peerId: ws.peerId, audioMuted: msg.audioMuted, videoOff: msg.videoOff });
                    }
                });
                break;
            }

            case 'leave-room': {
                handleDisconnect(ws);
                break;
            }
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
    console.log(`👋 ${ws.name} left room ${ws.roomCode} (${room.members.size} remaining)`);

    // Notify remaining members
    room.members.forEach((memberWs) => {
        memberWs.sendJSON({ type: 'peer-left', peerId: ws.peerId });
    });

    // Clean up empty rooms
    if (room.members.size === 0) {
        rooms.delete(ws.roomCode);
        console.log(`🗑️  Room ${ws.roomCode} removed (empty)`);
    }

    ws.roomCode = null;
}

// ─── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🎬 StreamFlow Server                                     ║
║                                                            ║
║   Lobby:  http://localhost:${PORT}/lobby.html               ║
║   Proxy:  http://localhost:${PORT}/proxy?url=VIDEO_URL      ║
║   WS:     ws://localhost:${PORT}                            ║
║                                                            ║
║   Press Ctrl+C to stop                                     ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
    `);
});
