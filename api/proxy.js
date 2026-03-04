/**
 * Vercel Serverless Function — Video Proxy
 * Bypasses CORS/hotlink restrictions for video streaming
 *
 * Route: /api/proxy?url=VIDEO_URL  (also mapped from /proxy)
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

module.exports = async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const videoUrl = req.query.url;
    if (!videoUrl) {
        res.status(400).json({ error: 'Missing ?url= parameter' });
        return;
    }

    try {
        await streamProxy(videoUrl, req, res);
    } catch (err) {
        console.error('Proxy error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
};

function streamProxy(videoUrl, clientReq, clientRes, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) {
            reject(new Error('Too many redirects'));
            return;
        }

        let parsedUrl;
        try {
            parsedUrl = new URL(videoUrl);
        } catch {
            reject(new Error('Invalid URL'));
            return;
        }

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
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers,
            timeout: 30000
        };

        const proxyReq = protocol.request(options, (proxyRes) => {
            // Handle redirects
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                let redirectUrl = proxyRes.headers.location;
                if (redirectUrl.startsWith('/')) {
                    redirectUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}${redirectUrl}`;
                }
                streamProxy(redirectUrl, clientReq, clientRes, redirectCount + 1)
                    .then(resolve).catch(reject);
                return;
            }

            const responseHeaders = {
                'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache'
            };
            if (proxyRes.headers['content-length']) {
                responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
            }
            if (proxyRes.headers['content-range']) {
                responseHeaders['Content-Range'] = proxyRes.headers['content-range'];
            }

            if (!clientRes.headersSent) {
                clientRes.writeHead(proxyRes.statusCode, responseHeaders);
            }

            proxyRes.pipe(clientRes);
            proxyRes.on('end', resolve);
            proxyRes.on('error', (err) => {
                if (!clientRes.headersSent) reject(err);
                else resolve();
            });
        });

        proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('Request timeout')); });
        proxyReq.on('error', reject);
        clientReq.on('close', () => proxyReq.destroy());
        proxyReq.end();
    });
}
