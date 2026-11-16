// VLESS + WebSocket node launcher for Abasthan.
//
// Layout (v2): Xray listens on an internal port only (127.0.0.1:5001).
// A small Node front proxy listens on the public ports (5000 = the
// Cloudflare Tunnel target, 9400 = the port Abasthan assigns/routes,
// plus the platform-provided PORT when different). The proxy answers
// non-WS requests with 200 "ok" (platform health checks kept the v1
// app in a restart loop because Xray only ever returns 404/400) and
// relays the WS path to Xray, for both plain HTTP and Upgrade requests.
//
// Required env var: UUID (set it in the app's environment variables,
// never commit it).
// Optional env vars: PORT (platform-provided), WS_PATH (default /ws),
// ARGO_TOKEN (Cloudflare Tunnel token; when set, cloudflared is also
// started. NOTE: on Abasthan free instances outbound TCP/UDP 7844 to
// the Cloudflare edge appears blocked (cloudflared precheck hard-fails),
// so the tunnel may never register there; the node is then reached
// directly through the platform subdomain instead.)

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '0', 10);
const XRAY_PORT = 5001;
const FRONT_PORTS = [...new Set([5000, 9400, PORT].filter((p) => p && p !== XRAY_PORT))];
const UUID = process.env.UUID;
const WS_PATH = process.env.WS_PATH || '/ws';
const ARGO_TOKEN = process.env.ARGO_TOKEN || '';
const XRAY_VERSION = 'v1.8.24';
const XRAY_DIR = path.join(__dirname, '.xray');
const XRAY_BIN = path.join(XRAY_DIR, 'xray');
const ZIP_PATH = path.join(__dirname, 'xray-download.zip');
const ZIP_URL =
  'https://github.com/XTLS/Xray-core/releases/download/' +
  XRAY_VERSION +
  '/Xray-linux-64.zip';
const CF_DIR = path.join(__dirname, '.cloudflared');
const CF_BIN = path.join(CF_DIR, 'cloudflared');
const CF_URL =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

if (!UUID) {
  console.error('ERROR: UUID environment variable is not set. Set it in the app environment variables and restart.');
  process.exit(1);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          download(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error('Download failed, HTTP ' + res.statusCode + ' for ' + url));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

async function ensureXray() {
  if (fs.existsSync(XRAY_BIN)) return;
  fs.mkdirSync(XRAY_DIR, { recursive: true });
  console.log('Downloading Xray-core ' + XRAY_VERSION + ' ...');
  await download(ZIP_URL, ZIP_PATH);
  const AdmZip = require('adm-zip');
  new AdmZip(ZIP_PATH).extractAllTo(XRAY_DIR, true);
  fs.chmodSync(XRAY_BIN, 0o755);
  fs.unlinkSync(ZIP_PATH);
  console.log('Xray-core ready.');
}

async function ensureCloudflared() {
  if (fs.existsSync(CF_BIN)) return;
  fs.mkdirSync(CF_DIR, { recursive: true });
  console.log('Downloading cloudflared ...');
  await download(CF_URL, CF_BIN);
  fs.chmodSync(CF_BIN, 0o755);
  console.log('cloudflared ready.');
}

function writeConfig() {
  const cfg = {
    log: { loglevel: 'warning' },
    // Resolve target domains through public DNS and prefer IPv4: on the
    // previous host the container's local resolver intermittently timed
    // out, and IPv4 egress was the reliable path.
    dns: {
      servers: ['1.1.1.1', '8.8.8.8'],
      queryStrategy: 'UseIPv4',
    },
    inbounds: [
      {
        listen: '127.0.0.1',
        port: XRAY_PORT,
        protocol: 'vless',
        settings: {
          clients: [{ id: UUID }],
          decryption: 'none',
        },
        streamSettings: {
          network: 'ws',
          security: 'none',
          wsSettings: { path: WS_PATH },
        },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] },
      },
    ],
    outbounds: [
      { protocol: 'freedom', tag: 'direct', settings: { domainStrategy: 'UseIPv4' } },
      { protocol: 'blackhole', tag: 'blocked' },
    ],
  };
  const cfgPath = path.join(__dirname, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}

// --- front proxy ---------------------------------------------------------
// Answers platform health checks with 200 and relays WS_PATH traffic to
// Xray on the internal port.
function isWsPath(url) {
  const q = url.indexOf('?');
  return (q === -1 ? url : url.slice(0, q)) === WS_PATH;
}

function startFrontProxy() {
  for (const port of FRONT_PORTS) {
    const server = http.createServer((req, res) => {
      if (!isWsPath(req.url)) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: XRAY_PORT,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (up) => {
          res.writeHead(up.statusCode || 502, up.headers);
          up.pipe(res);
        }
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('bad gateway');
      });
      req.pipe(upstream);
    });
    server.on('upgrade', (req, socket, head) => {
      if (!isWsPath(req.url)) {
        socket.destroy();
        return;
      }
      const upstream = net.connect(XRAY_PORT, '127.0.0.1', () => {
        let raw = req.method + ' ' + req.url + ' HTTP/' + req.httpVersion + '\r\n';
        for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
          raw += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n';
        }
        raw += '\r\n';
        upstream.write(raw);
        if (head && head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
    server.on('error', (err) => console.error('front proxy on ' + port + ' failed: ' + err.message));
    server.listen(port, '0.0.0.0', () => console.log('Front proxy listening on port ' + port));
  }
}

// --- cloudflared supervision -------------------------------------------
// On the previous host (2026-11-15) the tunnel died silently: cloudflared
// never logged a disconnect, but its attempts to refresh the container's
// local DNS resolver kept timing out and the tunnel never re-registered.
// Two defences:
// 1) Resolve the tunnel edge IPs ourselves through 1.1.1.1/8.8.8.8
//    (bypassing the container resolver) and pass them via --edge.
// 2) Poll cloudflared's metrics /ready endpoint; if it reports no
//    registered connections for many checks in a row, kill it so the
//    supervisor restarts and re-registers it. The threshold is generous
//    (10 checks) because on hosts where outbound 7844 is blocked the
//    tunnel can never register and constant restarts only waste CPU.
let cfProc = null;
let cfUseEdge = true;
let cfRapidExits = 0;
let cfStartedAt = 0;
let cfBadChecks = 0;
const CF_BAD_LIMIT = 10;

async function resolveEdgeAddrs() {
  const { Resolver } = require('dns').promises;
  const resolver = new Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  const ips = [];
  for (const name of ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com']) {
    try {
      const addrs = await resolver.resolve4(name);
      for (const ip of addrs.slice(0, 2)) {
        if (!ips.includes(ip)) ips.push(ip);
      }
    } catch (err) {
      console.log('edge resolve failed for ' + name + ': ' + err.message);
    }
  }
  return ips;
}

async function startCloudflared() {
  let edgeArgs = [];
  if (cfUseEdge) {
    const ips = await resolveEdgeAddrs();
    if (ips.length) {
      edgeArgs = [];
      for (const ip of ips) edgeArgs.push('--edge', ip + ':7844');
      console.log('cloudflared edge IPs (via 1.1.1.1): ' + ips.join(', '));
    } else {
      console.log('edge resolution returned nothing; falling back to default edge discovery.');
    }
  }
  console.log('Starting cloudflared tunnel ...');
  // Force HTTP/2 (TCP) transport: QUIC (UDP) connections were dropped
  // every ~2-3 minutes on the previous host with "timeout: no recent
  // network activity".
  cfStartedAt = Date.now();
  cfBadChecks = 0;
  const cf = spawn(
    CF_BIN,
    [
      'tunnel',
      '--no-autoupdate',
      '--protocol',
      'http2',
      '--metrics',
      '127.0.0.1:19090',
      ...edgeArgs,
      'run',
      '--token',
      ARGO_TOKEN,
    ],
    { stdio: 'inherit' }
  );
  cfProc = cf;
  cf.on('exit', (code) => {
    if (cfProc === cf) cfProc = null;
    const lived = Date.now() - cfStartedAt;
    if (edgeArgs.length && lived < 25000) {
      cfRapidExits += 1;
      if (cfRapidExits >= 2) {
        cfUseEdge = false;
        console.log('cloudflared keeps exiting quickly with --edge; disabling --edge for future starts.');
      }
    } else {
      cfRapidExits = 0;
    }
    console.log('cloudflared exited with code ' + code + ', restarting in 5s ...');
    setTimeout(() => {
      startCloudflared().catch((err) => console.error('cloudflared restart failed:', err.message));
    }, 5000);
  });
  return cf;
}

function startCfMonitor() {
  setInterval(() => {
    if (!cfProc) return; // the exit handler is already restarting it
    let settled = false;
    const req = http.get('http://127.0.0.1:19090/ready', (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        settled = true;
        let ready = 0;
        try {
          ready = JSON.parse(body).readyConnections || 0;
        } catch (err) {
          /* keep ready = 0 */
        }
        if (res.statusCode === 200 && ready > 0) {
          cfBadChecks = 0;
          return;
        }
        cfBadChecks += 1;
        console.log(
          'cloudflared health check bad (' +
            cfBadChecks +
            '/' +
            CF_BAD_LIMIT +
            '): HTTP ' +
            res.statusCode +
            ', readyConnections ' +
            ready
        );
        if (cfBadChecks >= CF_BAD_LIMIT && cfProc) {
          console.log('cloudflared unhealthy ' + CF_BAD_LIMIT + ' checks in a row; killing it so it re-registers.');
          cfBadChecks = 0;
          cfProc.kill('SIGKILL');
        }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('health check timeout')));
    req.on('error', (err) => {
      if (settled) return;
      cfBadChecks += 1;
      console.log('cloudflared health check error (' + cfBadChecks + '/' + CF_BAD_LIMIT + '): ' + err.message);
      if (cfBadChecks >= CF_BAD_LIMIT && cfProc) {
        console.log('cloudflared unreachable ' + CF_BAD_LIMIT + ' checks in a row; killing it so it re-registers.');
        cfBadChecks = 0;
        cfProc.kill('SIGKILL');
      }
    });
  }, 60000);
}

(async () => {
  await ensureXray();
  const cfgPath = writeConfig();
  console.log('Starting Xray: VLESS+WS on internal port ' + XRAY_PORT + ', path ' + WS_PATH);
  const child = spawn(XRAY_BIN, ['run', '-config', cfgPath], { stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log('Xray exited with code ' + code);
    process.exit(code == null ? 1 : code);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => child.kill(sig));
  }

  startFrontProxy();
  console.log('Front proxy ports: ' + FRONT_PORTS.join(', ') + ' -> Xray ' + XRAY_PORT);

  if (ARGO_TOKEN) {
    try {
      await ensureCloudflared();
      await startCloudflared();
      startCfMonitor();
    } catch (err) {
      console.error('cloudflared setup failed (Xray keeps running):', err.message);
    }
  } else {
    console.log('ARGO_TOKEN not set; Cloudflare tunnel disabled.');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
