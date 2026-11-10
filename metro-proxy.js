/* global Buffer */
/**
 * metro-proxy.js
 * Transparent HTTP proxy for Expo Metro bundler.
 * Rewrites manifest JSON so the bundle URL uses the tunnel hostname (no port),
 * allowing localtunnel / localhost.run to forward it correctly.
 *
 * Usage:
 *   TUNNEL_HOST=abc.loca.lt node metro-proxy.js
 */

const http = require('http');

const METRO_PORT = 8081;
const PROXY_PORT = 9090;
const TUNNEL_HOST = process.env.TUNNEL_HOST || 'localhost';
const TUNNEL_HTTPS = process.env.TUNNEL_HTTPS !== 'false'; // default true

const EXPO_ACCEPT = ['application/expo+json', 'application/json'];

function isManifestRequest(req) {
  const accept = req.headers['accept'] || '';
  return EXPO_ACCEPT.some((t) => accept.includes(t)) || req.url === '/';
}

function rewriteUrl(originalUrl) {
  // Replace http://hostname:port/ with https://TUNNEL_HOST/
  return originalUrl.replace(
    /https?:\/\/[^/]+\//,
    `${TUNNEL_HTTPS ? 'https' : 'http'}://${TUNNEL_HOST}/`
  );
}

function rewriteManifest(body) {
  try {
    const json = JSON.parse(body);

    // Classic Expo SDK 53 manifest
    if (json.launchAsset && json.launchAsset.url) {
      json.launchAsset.url = rewriteUrl(json.launchAsset.url);
    }
    // Assets list
    if (Array.isArray(json.assets)) {
      json.assets = json.assets.map((asset) => ({
        ...asset,
        url: asset.url ? rewriteUrl(asset.url) : asset.url,
      }));
    }
    // Legacy bundleUrl / debuggerHost
    if (json.bundleUrl) json.bundleUrl = rewriteUrl(json.bundleUrl);
    if (json.packagerOpts) json.packagerOpts = json.packagerOpts;

    return JSON.stringify(json);
  } catch (e) {
    return body;
  }
}

const server = http.createServer((req, res) => {
  const isManifest = isManifestRequest(req);

  const options = {
    hostname: 'localhost',
    port: METRO_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `localhost:${METRO_PORT}`,
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const contentType = proxyRes.headers['content-type'] || '';
    const isJson = contentType.includes('json');

    if (isManifest && isJson) {
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const rewritten = rewriteManifest(raw);
        const buf = Buffer.from(rewritten, 'utf8');

        const headers = { ...proxyRes.headers };
        headers['content-length'] = buf.byteLength;
        delete headers['transfer-encoding'];

        res.writeHead(proxyRes.statusCode || 200, headers);
        res.end(buf);
      });
    } else {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Proxy error: ' + err.message);
    }
  });

  req.pipe(proxyReq);
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`Metro proxy running on :${PROXY_PORT}`);
  console.log(`Forwarding to Metro on :${METRO_PORT}`);
  console.log(`Tunnel host: ${TUNNEL_HTTPS ? 'https' : 'http'}://${TUNNEL_HOST}`);
});
