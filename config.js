/**
 * StreamFlow — Frontend Configuration
 *
 * LOCAL DEV:
 *   Leave wsUrl as-is (auto-detects localhost:4000)
 *
 * PRODUCTION (after deploying signaling-server.js to Render):
 *   Replace the wsUrl with your Render WebSocket URL, e.g.:
 *   wsUrl: 'wss://streamflow-signal.onrender.com'
 */
window.SF_CONFIG = {
    // Auto-detect: localhost in dev, must be set for production
    wsUrl: window.location.hostname === 'localhost'
        ? `ws://localhost:${window.location.port || 4000}`
        : 'wss://YOUR-SIGNALING-SERVER.onrender.com'   // ← Replace this after deploying
};
