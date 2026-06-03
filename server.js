const WebSocket = require('ws');
const net = require('net');
const dgram = require('dgram');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const url = require('url');

// Constants
const horse = Buffer.from("dHJvamFu", 'base64').toString(); // "trojan"
const flash = Buffer.from("dm1lc3M=", 'base64').toString(); // "vmess"
const v2 = Buffer.from("djJyYXk=", 'base64').toString(); // "v2ray"
const neko = Buffer.from("Y2xhc2g=", 'base64').toString(); // "clash"

const KV_PRX_URL = "https://raw.githubusercontent.com/backup-heavenly-demons/gateway/refs/heads/main/kvProxyList.json";
const DNS_SERVER_ADDRESS = "8.8.8.8";
const DNS_SERVER_PORT = 53;
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const CORS_HEADER_OPTIONS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Max-Age": "86400",
};

// Region Mapping
const REGION_MAP = {
  ASIA: ["ID", "SG", "MY", "PH", "TH", "VN", "JP", "KR", "CN", "HK", "TW"],
  SOUTHASIA: ["IN", "BD", "PK", "LK", "NP", "AF", "BT", "MV"],
  CENTRALASIA: ["KZ", "UZ", "TM", "KG", "TJ"],
  NORTHASIA: ["RU"],
  MIDDLEEAST: ["AE", "SA", "IR", "IQ", "JO", "IL", "YE", "SY", "OM", "KW", "QA", "BH", "LB"],
  CIS: ["RU", "UA", "BY", "KZ", "UZ", "AM", "GE", "MD", "TJ", "KG", "TM", "AZ"],
  WESTEUROPE: ["FR", "DE", "NL", "BE", "AT", "CH", "IE", "LU", "MC"],
  EASTEUROPE: ["PL", "CZ", "SK", "HU", "RO", "BG", "MD", "UA", "BY"],
  NORTHEUROPE: ["SE", "FI", "NO", "DK", "EE", "LV", "LT", "IS"],
  SOUTHEUROPE: ["IT", "ES", "PT", "GR", "HR", "SI", "MT", "AL", "BA", "RS", "ME", "MK"],
  EUROPE: ["FR", "DE", "NL", "BE", "AT", "CH", "IE", "LU", "MC", "PL", "CZ", "SK", "HU", "RO", "BG", "MD", "UA", "BY", "SE", "FI", "NO", "DK", "EE", "LV", "LT", "IS", "IT", "ES", "PT", "GR", "HR", "SI", "MT", "AL", "BA", "RS", "ME", "MK"],
  AFRICA: ["ZA", "NG", "EG", "MA", "KE", "DZ", "TN", "GH", "CI", "SN", "ET"],
  NORTHAMERICA: ["US", "CA", "MX"],
  SOUTHAMERICA: ["BR", "AR", "CL", "CO", "PE", "VE", "EC", "UY", "PY", "BO"],
  LATAM: ["MX", "BR", "AR", "CL", "CO", "PE", "VE", "EC", "UY", "PY", "BO", "CR", "GT", "PA", "DO", "HN", "NI", "SV"],
  AMERICA: ["US", "CA", "MX", "BR", "AR", "CL", "CO", "PE", "VE", "EC"],
  OCEANIA: ["AU", "NZ", "PG", "FJ"],
  GLOBAL: []
};

class GatewayServer {
  constructor() {
    this.prxIP = "";
    this.cachedPrxList = [];
    this.wss = null;
    this.httpServer = null;
    this.activeUDPConnections = new Map();
    this.CORS_HEADER_OPTIONS = CORS_HEADER_OPTIONS;
  }

  // ==================== HTTP HANDLERS ====================

  // Health check handler
  handleHealthCheck(req, res) {
    const healthData = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'railway-gateway',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: process.env.npm_package_version || '1.0.0',
      features: {
        websocket: true,
        tcp: true,
        udp: true,
        protocols: ['trojan', 'vmess', 'ss']
      },
      network: {
        udp_supported: true,
        outbound_allowed: true
      }
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      ...this.CORS_HEADER_OPTIONS
    });
    res.end(JSON.stringify(healthData, null, 2));
  }

  // Handle CORS preflight
  handleCorsPreflight(req, res) {
    res.writeHead(200, this.CORS_HEADER_OPTIONS);
    res.end();
  }

  // API endpoint untuk mendapatkan daftar proxy
  async handleApiRequest(req, res, parsedUrl) {
    try {
      if (parsedUrl.pathname === '/api/proxies') {
        const proxies = await this.getPrxList(process.env.PRX_BANK_URL);
        const format = parsedUrl.query.format || 'json';
        
        if (format === 'text') {
          const proxyText = proxies.map(p => 
            `${p.country} - ${p.prxIP}:${p.prxPort}`
          ).join('\n');
          
          res.writeHead(200, {
            'Content-Type': 'text/plain',
            ...this.CORS_HEADER_OPTIONS
          });
          res.end(proxyText);
          return;
        }
        
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...this.CORS_HEADER_OPTIONS
        });
        res.end(JSON.stringify(proxies, null, 2));
        return;
      }
    } catch (error) {
      console.error('API error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  // Main HTTP request handler (Cyberpunk Dashboard Modern UI)
  async handleHttpRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    
    if (req.method === 'OPTIONS') {
      this.handleCorsPreflight(req, res);
      return;
    }
    
    if (parsedUrl.pathname === '/health') {
      this.handleHealthCheck(req, res);
      return;
    }
    
    if (parsedUrl.pathname.startsWith('/api/')) {
      await this.handleApiRequest(req, res, parsedUrl);
      return;
    }
    
    if (parsedUrl.pathname === '/') {
      const currentHost = req.headers.host || 'localhost:3000';
      const protocolWs = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
      const protocolHttp = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Khusus Config SNI | VLESS & Trojan</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
    * { box-sizing: border-box; }
    :root { color-scheme: dark; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #ecfeff;
      background:
        radial-gradient(circle at 0% 0%, rgba(17, 185, 129, .18), transparent 28rem),
        radial-gradient(circle at 100% 0%, rgba(99, 102, 241, .20), transparent 26rem),
        linear-gradient(115deg, #052d28 0%, #061816 43%, #111827 100%);
      overflow-x: hidden;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      z-index: -2;
      pointer-events: none;
      background:
        radial-gradient(circle at 17% 12%, rgba(45, 212, 191, .18), transparent 20rem),
        radial-gradient(circle at 91% 13%, rgba(129, 140, 248, .28), transparent 17rem),
        radial-gradient(circle at 50% 105%, rgba(14, 165, 233, .08), transparent 26rem);
    }
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      background-image:
        linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px);
      background-size: 42px 42px;
      mask-image: linear-gradient(to bottom, rgba(0,0,0,.75), transparent 75%);
    }
    .shell {
      width: min(930px, calc(100% - 24px));
      margin: 14px auto 28px;
      border: 1px solid rgba(45, 212, 191, .17);
      border-radius: 30px;
      background:
        linear-gradient(118deg, rgba(2, 30, 28, .92), rgba(6, 24, 27, .89) 56%, rgba(22, 31, 55, .91));
      box-shadow: 0 28px 90px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.04);
      overflow: hidden;
      position: relative;
    }
    .shell::before {
      content: "";
      position: absolute;
      inset: -30% -15% auto auto;
      width: 330px;
      height: 270px;
      background: radial-gradient(circle, rgba(99, 102, 241, .28), transparent 66%);
      filter: blur(2px);
      pointer-events: none;
    }
    .glass {
      background: rgba(2, 27, 27, .56);
      border: 1px solid rgba(94, 234, 212, .13);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.035);
      backdrop-filter: blur(16px);
    }
    .soft {
      background: rgba(5, 22, 28, .62);
      border: 1px solid rgba(148, 163, 184, .14);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.025);
    }
    .brand-mark {
      width: 50px;
      height: 50px;
      border-radius: 18px;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, #2dd4bf 0%, #22c55e 38%, #6366f1 100%);
      box-shadow: 0 18px 40px rgba(45,212,191,.22), inset 0 1px 0 rgba(255,255,255,.38);
    }
    .hero-title {
      letter-spacing: -.055em;
      line-height: .96;
      font-size: clamp(2.15rem, 8vw, 4.35rem);
      font-weight: 900;
    }
    .gradient-word {
      background: linear-gradient(90deg, #25f4c8, #8cecff 45%, #8f8cff 72%, #ffffff 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .chip {
      min-height: 24px;
      padding: 0 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border-radius: 8px;
      border: 1px solid rgba(45, 212, 191, .25);
      background: rgba(20, 184, 166, .09);
      color: #5eead4;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: .04em;
      white-space: nowrap;
    }
    .label {
      display: block;
      margin-bottom: 9px;
      color: #7dd3fc;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: .22em;
      text-transform: uppercase;
    }
    .top-btn {
      height: 36px;
      padding: 0 13px;
      border-radius: 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 1px solid rgba(148, 163, 184, .22);
      background: rgba(15, 23, 42, .42);
      color: #e2e8f0;
      font-size: 11px;
      font-weight: 800;
      text-decoration: none;
      transition: transform .16s ease, border-color .16s ease, background .16s ease;
    }
    .top-btn:hover { border-color: rgba(94, 234, 212, .40); background: rgba(20, 184, 166, .09); }
    .btn { transition: transform .15s ease, border-color .15s ease, background .15s ease, opacity .15s ease; }
    .btn:active, .top-btn:active { transform: scale(.98); }
    .input {
      width: 100%;
      border-radius: 16px;
      border: 1px solid rgba(94, 234, 212, .16);
      background: rgba(2, 16, 23, .66);
      color: #f8fafc;
      padding: 13px 14px;
      outline: none;
      font-size: 13px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
    }
    .input:focus { border-color: rgba(45, 212, 191, .45); }
    .uri {
      word-break: break-all;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .scroll::-webkit-scrollbar { height: 5px; width: 5px; }
    .scroll::-webkit-scrollbar-thumb { background: rgba(94, 234, 212, .22); border-radius: 8px; }
    .dot { box-shadow: 0 0 14px rgba(52,211,153,.9); }
    .mini-card { border-radius: 20px; padding: 14px; }
    .config-card { border-radius: 22px; padding: 16px; }
    @media (max-width: 680px) {
      .shell { width: calc(100% - 18px); margin-top: 9px; border-radius: 24px; }
      .content-pad { padding: 16px; }
      .brand-mark { width: 44px; height: 44px; border-radius: 15px; }
      .hero-title { font-size: clamp(2.25rem, 14vw, 3.2rem); }
      .top-actions { width: auto; align-self: flex-end; display: flex; }
      .top-btn { height: 34px; padding: 0 9px; font-size: 10px; }
      .mini-card { padding: 12px; border-radius: 16px; }
      .config-card { padding: 13px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="content-pad relative p-5 sm:p-7">
      <header class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-5">
        <div class="flex items-center gap-3">
          <div class="brand-mark">
            <i class="fa-solid fa-shield-halved text-white text-2xl"></i>
          </div>
          <div>
            <p class="text-[9px] font-black tracking-[.32em] text-teal-300 mb-1">J1BTNL</p>
            <h1 class="text-[22px] sm:text-2xl font-black tracking-[-.04em] text-white">Khusus Config SNI</h1>
          </div>
        </div>
        <div class="top-actions flex items-center gap-2">
          <a class="top-btn !px-0" href="${protocolHttp}://${currentHost}/health" target="_blank" aria-label="Health"><i class="fa-regular fa-moon text-teal-300"></i></a>
        </div>
      </header>

      <section class="mb-5">
        <h2 class="hero-title"><span class="gradient-word">VPN Config</span><br><span class="text-white">lifetime access.</span></h2>
        <p class="mt-3 text-sm sm:text-base text-cyan-100/62 max-w-2xl">VLESS dan Trojan siap salin, bug bisa diisi untuk Host dan SNI.</p>
      </section>

      <section class="glass rounded-2xl p-3 mb-2.5">
        <span class="label">Pilih Protokol</span>
        <div class="flex flex-wrap gap-2">
          <span class="chip">VLESS</span>
          <span class="chip">TROJAN</span>
        </div>
      </section>

      <section class="glass rounded-2xl p-3.5 mb-4 flex items-center gap-3">
        <div class="h-10 w-10 rounded-2xl bg-teal-400/10 border border-teal-300/15 grid place-items-center shrink-0">
          <i class="fa-solid fa-code text-teal-300"></i>
        </div>
        <div class="min-w-0">
          <p class="text-[10px] font-black tracking-[.22em] text-teal-300 uppercase">Custom Path</p>
          <p class="text-xs text-cyan-100/55 mt-1">Tetap memakai path otomatis: <span class="rounded-md bg-slate-950/55 px-2 py-0.5 text-white font-black">/ID</span></p>
        </div>
      </section>

      <section class="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-4">
        <article class="glass mini-card">
          <p class="text-[10px] font-black tracking-[.18em] text-cyan-100/38 mb-2">STATUS</p>
          <p id="status-val" class="text-sm font-black text-emerald-300 flex items-center gap-2"><span id="status-dot" class="dot h-2 w-2 rounded-full bg-emerald-400"></span><span id="status-text">ONLINE</span></p>
        </article>
        <article class="glass mini-card">
          <p class="text-[10px] font-black tracking-[.18em] text-cyan-100/38 mb-2">UPTIME</p>
          <p id="uptime-val" class="text-sm font-black text-white">0s</p>
        </article>
        <article class="glass mini-card">
          <p class="text-[10px] font-black tracking-[.18em] text-cyan-100/38 mb-2">MEMORY</p>
          <p id="memory-val" class="text-sm font-black text-white">${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB</p>
        </article>
        <article class="glass mini-card">
          <p class="text-[10px] font-black tracking-[.18em] text-cyan-100/38 mb-2">NODE</p>
          <p class="text-sm font-black text-sky-300">${process.version}</p>
        </article>
      </section>

      <main class="grid grid-cols-1 lg:grid-cols-[.85fr_1.15fr] gap-4">
        <section class="glass rounded-3xl p-4 sm:p-5">
          <div class="flex items-start justify-between gap-3 mb-4">
            <div>
              <h2 class="font-black text-white text-lg tracking-[-.03em]">Buat Config</h2>
              <p class="text-xs text-cyan-100/50 mt-1">UUID otomatis untuk config.</p>
            </div>
            <button onclick="newUuid()" class="btn rounded-xl border border-teal-300/20 bg-teal-400/10 px-3 py-2 text-[11px] font-black text-teal-200">
              <i class="fa-solid fa-wand-magic-sparkles mr-1"></i> Baru
            </button>
          </div>

          <label class="block">
            <span class="label">UUID / Password</span>
            <div class="flex gap-2">
              <input id="uuid" class="input" readonly>
              <button onclick="copyValue('uuid')" class="btn rounded-2xl border border-cyan-100/12 bg-slate-950/35 px-4 text-cyan-100/75" aria-label="Salin UUID"><i class="fa-regular fa-copy"></i></button>
            </div>
          </label>

          <label class="block mt-4">
            <span class="label">Masukkan Bug</span>
            <input id="bugHost" class="input" type="text" inputmode="url" autocomplete="off" placeholder="contoh: bug.domain.com" oninput="generateConfigs()">
          </label>

          <div class="soft rounded-2xl p-3.5 mt-4">
            <p class="text-xs text-cyan-100/55 leading-5"><i class="fa-solid fa-circle-info text-teal-300 mr-2"></i>Address mengikuti hostname halaman. Host dan SNI memakai bug yang dimasukkan; jika kosong otomatis memakai hostname.</p>
          </div>
        </section>

        <section class="glass rounded-3xl p-4 sm:p-5 flex flex-col gap-3">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="font-black text-white text-lg tracking-[-.03em]">Hasil Config</h2>
              <p class="text-xs text-cyan-100/50 mt-1">Klik salin untuk mengambil config.</p>
            </div>
            <button onclick="copyAll()" class="btn rounded-xl border border-violet-300/22 bg-violet-400/10 px-3 py-2 text-[11px] font-black text-violet-200 whitespace-nowrap">
              <i class="fa-regular fa-copy mr-1"></i> Semua
            </button>
          </div>

          <article class="soft config-card">
            <div class="flex items-center justify-between gap-3 mb-3">
              <div class="flex items-center gap-2 min-w-0"><span class="chip !text-violet-200 !border-violet-300/24 !bg-violet-400/10">VLESS</span></div>
              <button onclick="copyConfig('vless')" class="btn rounded-xl bg-violet-500/14 border border-violet-300/18 px-3 py-1.5 text-xs font-bold text-violet-100"><i class="fa-regular fa-copy mr-1"></i> Salin</button>
            </div>
            <div id="vless" class="uri scroll text-xs text-cyan-50/70 leading-5 max-h-24 overflow-y-auto"></div>
          </article>

          <article class="soft config-card">
            <div class="flex items-center justify-between gap-3 mb-3">
              <div class="flex items-center gap-2 min-w-0"><span class="chip">TROJAN</span></div>
              <button onclick="copyConfig('trojan')" class="btn rounded-xl bg-teal-500/12 border border-teal-300/18 px-3 py-1.5 text-xs font-bold text-teal-100"><i class="fa-regular fa-copy mr-1"></i> Salin</button>
            </div>
            <div id="trojan" class="uri scroll text-xs text-cyan-50/70 leading-5 max-h-24 overflow-y-auto"></div>
          </article>

          <div class="grid grid-cols-2 gap-2 mt-auto">
            <a class="btn rounded-2xl border border-cyan-100/12 bg-slate-950/28 py-3 text-center text-[11px] font-black text-cyan-100/66 hover:border-teal-300/25" href="${protocolHttp}://${currentHost}/api/proxies" target="_blank"><i class="fa-solid fa-database mr-1.5 text-teal-300"></i> Proxy API</a>
            <a class="btn rounded-2xl border border-cyan-100/12 bg-slate-950/28 py-3 text-center text-[11px] font-black text-cyan-100/66 hover:border-teal-300/25" href="${protocolHttp}://${currentHost}/health" target="_blank"><i class="fa-solid fa-heart-pulse mr-1.5 text-emerald-300"></i> Health</a>
          </div>
        </section>
      </main>
    </div>
  </div>

  <div id="toast" class="fixed bottom-5 left-1/2 -translate-x-1/2 translate-y-3 opacity-0 pointer-events-none transition rounded-2xl bg-cyan-50 text-slate-950 px-4 py-2.5 text-xs font-black shadow-xl">
    <i class="fa-solid fa-circle-check text-emerald-600 mr-2"></i><span id="toastText">Tersalin</span>
  </div>

  <script>
    const FIXED_PORT = '443';
    const FIXED_SECURITY = 'tls';
    const FIXED_PATH = '/ID';
    const HEALTH_ENDPOINT = '/health';
    let uptimeSeconds = ${Math.floor(process.uptime())};
    let healthOnline = true;
    function randomUuid() {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 3 | 8);
        return v.toString(16);
      });
    }
    function activeHost() { return window.location.hostname || 'localhost'; }
    function cleanHost(value) {
      return String(value || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/^wss?:\/\//i, '')
        .split('/')[0]
        .split('?')[0]
        .replace(/\s+/g, '');
    }
    function formatUptime(total) {
      const days = Math.floor(total / 86400); total %= 86400;
      const hours = Math.floor(total / 3600); total %= 3600;
      const minutes = Math.floor(total / 60); const seconds = total % 60;
      if (days) return days + 'd ' + hours + 'h ' + minutes + 'm';
      if (hours) return hours + 'h ' + minutes + 'm ' + seconds + 's';
      if (minutes) return minutes + 'm ' + seconds + 's';
      return seconds + 's';
    }
    function renderUptime() { document.getElementById('uptime-val').textContent = formatUptime(Math.max(0, Math.floor(uptimeSeconds))); }
    function renderMemory(bytes) {
      const value = Number(bytes);
      document.getElementById('memory-val').textContent = Number.isFinite(value) ? Math.round(value / 1024 / 1024) + ' MB' : '-- MB';
    }
    function renderStatus(online) {
      const text = document.getElementById('status-text');
      const wrapper = document.getElementById('status-val');
      const dot = document.getElementById('status-dot');
      text.textContent = online ? 'ONLINE' : 'OFFLINE';
      wrapper.classList.toggle('text-emerald-300', online);
      wrapper.classList.toggle('text-rose-300', !online);
      dot.classList.toggle('bg-emerald-400', online);
      dot.classList.toggle('bg-rose-400', !online);
    }
    async function refreshStats() {
      try {
        const response = await fetch(HEALTH_ENDPOINT, { cache: 'no-store' });
        if (!response.ok) throw new Error('health request failed');
        const data = await response.json();
        if (Number.isFinite(Number(data.uptime))) uptimeSeconds = Number(data.uptime);
        if (data.memory && data.memory.heapUsed !== undefined) renderMemory(data.memory.heapUsed);
        healthOnline = true;
        renderStatus(true);
        renderUptime();
      } catch (error) {
        healthOnline = false;
        renderStatus(false);
      }
    }
    function generateConfigs() {
      const uuid = document.getElementById('uuid').value;
      const addressHost = activeHost();
      const bugInput = document.getElementById('bugHost');
      const bugHost = cleanHost(bugInput ? bugInput.value : '') || addressHost;
      const encodedBugHost = encodeURIComponent(bugHost);
      const encodedPath = encodeURIComponent(FIXED_PATH);
      const common = 'security=' + FIXED_SECURITY + '&type=ws&host=' + encodedBugHost + '&path=' + encodedPath + '&sni=' + encodedBugHost + '&fp=random';
      document.getElementById('vless').textContent = 'vless://' + uuid + '@' + addressHost + ':' + FIXED_PORT + '?encryption=none&' + common + '#J1BTNL%20VLESS';
      document.getElementById('trojan').textContent = 'trojan://' + uuid + '@' + addressHost + ':' + FIXED_PORT + '?' + common + '#J1BTNL%20TROJAN';
    }
    function newUuid() { document.getElementById('uuid').value = randomUuid(); generateConfigs(); showToast('UUID baru dibuat'); }
    function putClipboard(text, message) {
      navigator.clipboard.writeText(text).then(function(){ showToast(message); }).catch(function(){ showToast('Gagal menyalin'); });
    }
    function copyValue(id) { putClipboard(document.getElementById(id).value, 'UUID disalin'); }
    function copyConfig(id) { putClipboard(document.getElementById(id).textContent, id.toUpperCase() + ' disalin'); }
    function copyAll() { putClipboard(document.getElementById('vless').textContent + '\n' + document.getElementById('trojan').textContent, 'Semua config disalin'); }
    function showToast(message) {
      const toast = document.getElementById('toast');
      document.getElementById('toastText').textContent = message;
      toast.classList.remove('opacity-0','translate-y-3','pointer-events-none');
      clearTimeout(window.toastTimer);
      window.toastTimer = setTimeout(function(){ toast.classList.add('opacity-0','translate-y-3','pointer-events-none'); }, 1900);
    }
    document.getElementById('uuid').value = randomUuid();
    renderUptime();
    renderStatus(true);
    generateConfigs();
    refreshStats();
    setInterval(function(){ uptimeSeconds++; renderUptime(); }, 1000);
    setInterval(refreshStats, 5000);
  </script>
</body>
</html>
      `);
      return;
    }
    
    const targetReversePrx = process.env.REVERSE_PRX_TARGET;
    if (targetReversePrx) {
      await this.reverseWeb(req, res, targetReversePrx);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }

  // ==================== PROXY LIST MANAGEMENT ====================

  async getKVPrxList(kvPrxUrl = KV_PRX_URL) {
    if (!kvPrxUrl) {
      throw new Error("No URL Provided!");
    }

    try {
      const kvPrx = await fetch(kvPrxUrl);
      if (kvPrx.status == 200) {
        return await kvPrx.json();
      } else {
        console.error(`Failed to fetch KV proxy list: ${kvPrx.status}`);
        return {};
      }
    } catch (error) {
      console.error('Error fetching KV proxy list:', error);
      return {};
    }
  }

  async getPrxList(prxBankUrl) {
    if (!prxBankUrl) {
      return [];
    }

    try {
      const response = await fetch(prxBankUrl);
      if (response.status === 200) {
        const data = await response.json();
        
        return data.map(proxy => {
          const ip = proxy.prxIP || proxy.ip || proxy.server;
          const port = proxy.prxPort || proxy.port;
          const country = proxy.country || proxy.cc || 'XX';
          
          if (!ip || !port) {
            console.warn('Invalid proxy format:', proxy);
            return null;
          }
          
          return {
            prxIP: ip,
            prxPort: port,
            country: country.toUpperCase()
          };
        }).filter(Boolean);
      } else {
        console.error(`Failed to fetch proxy list: ${response.status}`);
        return [];
      }
    } catch (error) {
      console.error('Error fetching proxy list:', error);
      return [];
    }
  }

  // ==================== REVERSE PROXY ====================

  async reverseWeb(request, response, target, targetPath) {
    try {
      const targetUrl = new URL(request.url);
      const targetChunk = target.split(":");

      targetUrl.hostname = targetChunk[0];
      targetUrl.port = targetChunk[1]?.toString() || "443";
      targetUrl.pathname = targetPath || targetUrl.pathname;

      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: targetUrl.pathname + targetUrl.search,
        method: request.method,
        headers: { ...request.headers }
      };

      options.headers['host'] = targetUrl.hostname;
      options.headers['x-forwarded-host'] = request.headers.host;

      const proxyReq = (targetUrl.protocol === 'https:' ? https : http).request(options, (proxyRes) => {
        response.writeHead(proxyRes.statusCode, {
          ...Object.fromEntries(Object.entries(this.CORS_HEADER_OPTIONS)),
          ...Object.fromEntries(Object.entries(proxyRes.headers)),
          'x-proxied-by': 'Railway Gateway'
        });

        proxyRes.pipe(response);
      });

      proxyReq.on('error', (err) => {
        console.error('Proxy error:', err);
        response.writeHead(500);
        response.end('Proxy error');
      });

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        let body = [];
        request.on('data', (chunk) => {
          body.push(chunk);
        }).on('end', () => {
          proxyReq.write(Buffer.concat(body));
          proxyReq.end();
        });
      } else {
        proxyReq.end();
      }
    } catch (err) {
      console.error('Reverse web error:', err);
      response.writeHead(500);
      response.end('Internal server error');
    }
  }

  // ==================== WEBSOCKET HANDLERS ====================

  async handleWebSocketConnection(ws, request) {
    try {
      const parsedUrl = url.parse(request.url, true);
      const path = parsedUrl.pathname;
      const host = request.headers.host || 'localhost';

      console.log(`WebSocket request path: ${path} from ${request.socket.remoteAddress}`);

      // Format /PROXYLIST/ID,SG,JP
      const proxyListMatch = path.match(/^\/PROXYLIST\/([A-Z]{2}(,[A-Z]{2})*)$/i);
      if (proxyListMatch) {
        const countryCodes = proxyListMatch[1].toUpperCase().split(",");
        const proxies = await this.getPrxList(process.env.PRX_BANK_URL);

        if (proxies.length === 0) {
          const kvPrx = await this.getKVPrxList();
          const availableCountries = countryCodes.filter(code => kvPrx[code] && kvPrx[code].length > 0);
          if (availableCountries.length === 0) {
            ws.close(1000, `No proxies available for countries: ${countryCodes.join(",")}`);
            return;
          }
          const prxKey = availableCountries[Math.floor(Math.random() * availableCountries.length)];
          this.prxIP = kvPrx[prxKey][Math.floor(Math.random() * kvPrx[prxKey].length)];
        } else {
          const filteredProxies = proxies.filter(proxy => countryCodes.includes(proxy.country));
          if (filteredProxies.length === 0) {
            ws.close(1000, `No proxies available for countries: ${countryCodes.join(",")}`);
            return;
          }
          const randomProxy = filteredProxies[Math.floor(Math.random() * filteredProxies.length)];
          this.prxIP = `${randomProxy.prxIP}:${randomProxy.prxPort}`;
        }

        console.log(`Selected Proxy (/PROXYLIST/${countryCodes.join(",")}): ${this.prxIP}`);
        await this.websocketHandler(ws);
        return;
      }

      // Format /ALL atau /ALLn
      const allMatch = path.match(/^\/ALL(\d+)?$/i);
      if (allMatch) {
        const index = allMatch[1] ? parseInt(allMatch[1], 10) - 1 : null;
        const proxies = await this.getPrxList(process.env.PRX_BANK_URL);

        if (proxies.length === 0) {
          const kvPrx = await this.getKVPrxList();
          const allProxies = Object.values(kvPrx).flat();
          if (allProxies.length === 0) {
            ws.close(1000, `No proxies available for /ALL${index !== null ? index + 1 : ""}`);
            return;
          }
          this.prxIP = allProxies[Math.floor(Math.random() * allProxies.length)];
        } else {
          let selectedProxy;
          
          if (index === null) {
            selectedProxy = proxies[Math.floor(Math.random() * proxies.length)];
          } else {
            const groupedByCountry = proxies.reduce((acc, proxy) => {
              if (!acc[proxy.country]) acc[proxy.country] = [];
              acc[proxy.country].push(proxy);
              return acc;
            }, {});

            const proxiesByIndex = [];
            for (const country in groupedByCountry) {
              const countryProxies = groupedByCountry[country];
              if (index < countryProxies.length) {
                proxiesByIndex.push(countryProxies[index]);
              }
            }

            if (proxiesByIndex.length === 0) {
              ws.close(1000, `No proxy at index ${index + 1} for any country`);
              return;
            }

            selectedProxy = proxiesByIndex[Math.floor(Math.random() * proxiesByIndex.length)];
          }

          this.prxIP = `${selectedProxy.prxIP}:${selectedProxy.prxPort}`;
        }

        console.log(`Selected Proxy (/ALL${index !== null ? index + 1 : ""}): ${this.prxIP}`);
        await this.websocketHandler(ws);
        return;
      }

      // Format /PUTAR atau /PUTARn
      const putarMatch = path.match(/^\/PUTAR(\d+)?$/i);
      if (putarMatch) {
        const countryCount = putarMatch[1] ? parseInt(putarMatch[1], 10) : null;
        const proxies = await this.getPrxList(process.env.PRX_BANK_URL);

        if (proxies.length === 0) {
          const kvPrx = await this.getKVPrxList();
          const countries = Object.keys(kvPrx).filter(code => kvPrx[code] && kvPrx[code].length > 0);
          
          if (countries.length === 0) {
            ws.close(1000, `No proxies available for /PUTAR${countryCount || ""}`);
            return;
          }

          let selectedCountries;
          if (countryCount === null) {
            selectedCountries = countries;
          } else {
            const shuffled = [...countries].sort(() => Math.random() - 0.5);
            selectedCountries = shuffled.slice(0, Math.min(countryCount, countries.length));
          }

          const prxKey = selectedCountries[Math.floor(Math.random() * selectedCountries.length)];
          this.prxIP = kvPrx[prxKey][Math.floor(Math.random() * kvPrx[prxKey].length)];
        } else {
          const groupedByCountry = proxies.reduce((acc, proxy) => {
            if (!acc[proxy.country]) acc[proxy.country] = [];
            acc[proxy.country].push(proxy);
            return acc;
          }, {});

          const countries = Object.keys(groupedByCountry);
          if (countries.length === 0) {
            ws.close(1000, `No proxies available`);
            return;
          }

          let selectedCountries;
          if (countryCount === null) {
            selectedCountries = countries;
          } else {
            const shuffled = [...countries].sort(() => Math.random() - 0.5);
            selectedCountries = shuffled.slice(0, Math.min(countryCount, countries.length));
          }

          const selectedProxies = selectedCountries.map(country => {
            const countryProxies = groupedByCountry[country];
            return countryProxies[Math.floor(Math.random() * countryProxies.length)];
          });

          const randomProxy = selectedProxies[Math.floor(Math.random() * selectedProxies.length)];
          this.prxIP = `${randomProxy.prxIP}:${randomProxy.prxPort}`;
        }

        console.log(`Selected Proxy (/PUTAR${countryCount || ""}): ${this.prxIP}`);
        await this.websocketHandler(ws);
        return;
      }

      // Format /REGION atau /REGIONn
      const regionMatch = path.match(/^\/([A-Z]+)(\d+)?$/i);
      if (regionMatch) {
        const regionKey = regionMatch[1].toUpperCase();
        const index = regionMatch[2] ? parseInt(regionMatch[2], 10) - 1 : null;
        
        if (REGION_MAP[regionKey] !== undefined) {
          const countries = REGION_MAP[regionKey];
          const proxies = await this.getPrxList(process.env.PRX_BANK_URL);

          if (proxies.length === 0) {
            const kvPrx = await this.getKVPrxList();
            let availableProxies = [];
            
            if (regionKey === "GLOBAL") {
              availableProxies = Object.values(kvPrx).flat();
            } else {
              for (const country of countries) {
                if (kvPrx[country] && kvPrx[country].length > 0) {
                  availableProxies.push(...kvPrx[country]);
                }
              }
            }

            if (availableProxies.length === 0) {
              ws.close(1000, `No proxies available for region: ${regionKey}`);
              return;
            }

            if (index === null) {
              this.prxIP = availableProxies[Math.floor(Math.random() * availableProxies.length)];
            } else {
              if (index < 0 || index >= availableProxies.length) {
                ws.close(1000, `Index ${index + 1} out of range for region ${regionKey}`);
                return;
              }
              this.prxIP = availableProxies[index];
            }
          } else {
            const filteredProxies = regionKey === "GLOBAL" 
              ? proxies
              : proxies.filter(p => countries.includes(p.country));

            if (filteredProxies.length === 0) {
              ws.close(1000, `No proxies available for region: ${regionKey}`);
              return;
            }

            let selectedProxy;
            if (index === null) {
              selectedProxy = filteredProxies[Math.floor(Math.random() * filteredProxies.length)];
            } else {
              if (index < 0 || index >= filteredProxies.length) {
                ws.close(1000, `Index ${index + 1} out of range for region ${regionKey}`);
                return;
              }
              selectedProxy = filteredProxies[index];
            }

            this.prxIP = `${selectedProxy.prxIP}:${selectedProxy.prxPort}`;
          }

          console.log(`Selected Proxy (/${regionKey}${index !== null ? index + 1 : ""}): ${this.prxIP}`);
          await this.websocketHandler(ws);
          return;
        }
      }

      // Format /CC atau /CCn (Country Code)
      const countryMatch = path.match(/^\/([A-Z]{2})(\d+)?$/);
      if (countryMatch) {
        const countryCode = countryMatch[1].toUpperCase();
        const index = countryMatch[2] ? parseInt(countryMatch[2], 10) - 1 : null;
        const proxies = await this.getPrxList(process.env.PRX_BANK_URL);
        
        if (proxies.length === 0) {
          const kvPrx = await this.getKVPrxList();
          if (!kvPrx[countryCode] || kvPrx[countryCode].length === 0) {
            ws.close(1000, `No proxies available for country: ${countryCode}`);
            return;
          }

          if (index === null) {
            this.prxIP = kvPrx[countryCode][Math.floor(Math.random() * kvPrx[countryCode].length)];
          } else {
            if (index < 0 || index >= kvPrx[countryCode].length) {
              ws.close(1000, `Index ${index + 1} out of range for country ${countryCode}`);
              return;
            }
            this.prxIP = kvPrx[countryCode][index];
          }
        } else {
          const filteredProxies = proxies.filter(proxy => proxy.country === countryCode);
          if (filteredProxies.length === 0) {
            ws.close(1000, `No proxies available for country: ${countryCode}`);
            return;
          }

          let selectedProxy;
          if (index === null) {
            selectedProxy = filteredProxies[Math.floor(Math.random() * filteredProxies.length)];
          } else {
            if (index < 0 || index >= filteredProxies.length) {
              ws.close(1000, `Index ${index + 1} out of range for country ${countryCode}`);
              return;
            }
            selectedProxy = filteredProxies[index];
          }

          this.prxIP = `${selectedProxy.prxIP}:${selectedProxy.prxPort}`;
        }

        console.log(`Selected Proxy (/${countryCode}${index !== null ? index + 1 : ""}): ${this.prxIP}`);
        await this.websocketHandler(ws);
        return;
      }

      // Format /ip:port atau /ip=port atau /ip-port
      const ipPortMatch = path.match(/^\/(.+[:=-]\d+)$/);
      if (ipPortMatch) {
        this.prxIP = ipPortMatch[1].replace(/[=:-]/, ":");
        console.log(`Direct Proxy IP: ${this.prxIP}`);
        await this.websocketHandler(ws);
        return;
      }

      // Format lama untuk kompatibilitas
      if (path.length === 4 || path.includes(',')) {
        const prxKeys = path.replace("/", "").toUpperCase().split(",");
        const prxKey = prxKeys[Math.floor(Math.random() * prxKeys.length)];
        const kvPrx = await this.getKVPrxList();

        if (kvPrx[prxKey] && kvPrx[prxKey].length > 0) {
          this.prxIP = kvPrx[prxKey][Math.floor(Math.random() * kvPrx[prxKey].length)];
          console.log(`Legacy Proxy (/${prxKeys.join(",")}): ${this.prxIP}`);
          await this.websocketHandler(ws);
          return;
        } else {
          ws.close(1000, `No proxies available for country: ${prxKey}`);
          return;
        }
      }

      ws.close(1000, "Invalid WebSocket path format");
    } catch (err) {
      console.error('WebSocket connection error:', err);
      ws.close(1011, 'Internal server error');
    }
  }

  async websocketHandler(ws) {
    let addressLog = "";
    let portLog = "";
    const log = (info, event) => {
      console.log(`[${addressLog}:${portLog}] ${info}`, event || "");
    };

    let remoteSocketWrapper = { value: null };

    ws.on('message', async (message) => {
      try {
        const chunk = Buffer.from(message);

        if (remoteSocketWrapper.value) {
          remoteSocketWrapper.value.write(chunk);
          return;
        }

        const protocol = await this.protocolSniffer(chunk);
        let protocolHeader;

        if (protocol === horse) {
          protocolHeader = this.readHorseHeader(chunk);
        } else if (protocol === flash) {
          protocolHeader = this.readFlashHeader(chunk);
        } else if (protocol === "ss") {
          protocolHeader = this.readSsHeader(chunk);
        } else {
          throw new Error("Unknown Protocol!");
        }

        addressLog = protocolHeader.addressRemote;
        portLog = `${protocolHeader.portRemote} -> ${protocolHeader.isUDP ? "UDP" : "TCP"}`;

        if (protocolHeader.hasError) {
          throw new Error(protocolHeader.message);
        }

        if (protocolHeader.isUDP) {
          return await this.handleUDPOutbound(
            protocolHeader.addressRemote,
            protocolHeader.portRemote,
            chunk.slice(protocolHeader.rawDataIndex),
            ws,
            protocolHeader.version,
            log
          );
        }

        this.handleTCPOutBound(
          remoteSocketWrapper,
          protocolHeader.addressRemote,
          protocolHeader.portRemote,
          protocolHeader.rawClientData,
          ws,
          protocolHeader.version,
          log
        );
      } catch (err) {
        console.error('Error processing WebSocket message:', err);
        ws.close(1011, err.message);
      }
    });

    ws.on('close', () => {
      if (remoteSocketWrapper.value) {
        remoteSocketWrapper.value.end();
      }
      this.cleanupUDPConnections(ws);
      log('WebSocket closed');
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      this.cleanupUDPConnections(ws);
    });
  }

  // ==================== PROTOCOL SNIFFERS ====================

  async protocolSniffer(buffer) {
    if (buffer.length >= 62) {
      const horseDelimiter = buffer.slice(56, 60);
      if (horseDelimiter[0] === 0x0d && horseDelimiter[1] === 0x0a) {
        if (horseDelimiter[2] === 0x01 || horseDelimiter[2] === 0x03 || horseDelimiter[2] === 0x7f) {
          if (horseDelimiter[3] === 0x01 || horseDelimiter[3] === 0x03 || horseDelimiter[3] === 0x04) {
            return horse;
          }
        }
      }
    }

    const flashDelimiter = buffer.slice(1, 17);
    const hex = flashDelimiter.toString('hex');
    if (hex.match(/^[0-9a-f]{8}[0-9a-f]{4}4[0-9a-f]{3}[89ab][0-9a-f]{3}[0-9a-f]{12}$/i)) {
      return flash;
    }

    return "ss";
  }

  async handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, log) {
    const connectAndWrite = (address, port) => {
      return new Promise((resolve, reject) => {
        const tcpSocket = net.createConnection({
          host: address,
          port: port
        }, () => {
          log(`connected to ${address}:${port}`);
          tcpSocket.write(rawClientData);
          resolve(tcpSocket);
        });
        tcpSocket.on('error', reject);
      });
    };

    const retry = async () => {
      try {
        const tcpSocket = await connectAndWrite(
          this.prxIP.split(/[:=-]/)[0] || addressRemote,
          this.prxIP.split(/[:=-]/)[1] || portRemote
        );
        remoteSocket.value = tcpSocket;
        
        tcpSocket.on('close', () => { webSocket.close(); });
        tcpSocket.on('error', (error) => { webSocket.close(); });

        this.remoteSocketToWS(tcpSocket, webSocket, responseHeader, null, log);
      } catch (error) {
        webSocket.close();
      }
    };

    try {
      const tcpSocket = await connectAndWrite(addressRemote, portRemote);
      remoteSocket.value = tcpSocket;
      
      tcpSocket.on('close', () => { webSocket.close(); });
      tcpSocket.on('error', (error) => { webSocket.close(); });

      this.remoteSocketToWS(tcpSocket, webSocket, responseHeader, retry, log);
    } catch (error) {
      await retry();
    }
  }

  // ==================== UDP NATIVE HANDLER ====================

  async handleUDPOutbound(targetAddress, targetPort, dataChunk, webSocket, responseHeader, log) {
    return new Promise((resolve) => {
      try {
        let protocolHeader = responseHeader;
        const connectionKey = `${targetAddress}:${targetPort}:${Date.now()}`;
        const udpSocket = dgram.createSocket('udp4');
        
        this.activeUDPConnections.set(connectionKey, {
          socket: udpSocket,
          webSocket: webSocket
        });
        
        // AMAN: Tangani error socket langsung agar tidak memicu uncaught exceptions
        udpSocket.on('error', (error) => {
          console.error(`[UDP Socket Error] ${targetAddress}:${targetPort} ->`, error.message);
          try {
            udpSocket.close();
          } catch (_) {}
          this.activeUDPConnections.delete(connectionKey);
        });

        udpSocket.send(dataChunk, targetPort, targetAddress, (error) => {
          if (error) {
            console.error(`[UDP Send Error]`, error.message);
            try { udpSocket.close(); } catch (_) {}
            this.activeUDPConnections.delete(connectionKey);
            return;
          }
        });
        
        udpSocket.on('message', (message, rinfo) => {
          if (webSocket.readyState === WebSocket.OPEN) {
            if (protocolHeader) {
              const combined = Buffer.concat([Buffer.from(protocolHeader), message]);
              webSocket.send(combined);
              protocolHeader = null;
            } else {
              webSocket.send(message);
            }
          }
        });
        
        udpSocket.on('close', () => {
          this.activeUDPConnections.delete(connectionKey);
        });
        
        let idleTimeout = setTimeout(() => {
          if (udpSocket) {
            try { udpSocket.close(); } catch (_) {}
            this.activeUDPConnections.delete(connectionKey);
          }
        }, 30000);
        
        udpSocket.on('message', () => {
          clearTimeout(idleTimeout);
          idleTimeout = setTimeout(() => {
            if (udpSocket) {
              try { udpSocket.close(); } catch (_) {}
              this.activeUDPConnections.delete(connectionKey);
            }
          }, 30000);
        });
        
      } catch (e) {
        console.error(`Error in UDP handler execution: ${e.message}`);
      }
    });
  }

  cleanupUDPConnections(webSocket) {
    for (const [key, connection] of this.activeUDPConnections.entries()) {
      if (connection.webSocket === webSocket) {
        try {
          connection.socket.close();
        } catch (_) {}
        this.activeUDPConnections.delete(key);
      }
    }
  }

  readSsHeader(ssBuffer) {
    const addressType = ssBuffer[0];
    let addressLength = 0;
    let addressValueIndex = 1;
    let addressValue = "";

    switch (addressType) {
      case 1:
        addressLength = 4;
        addressValue = Array.from(ssBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".");
        break;
      case 3:
        addressLength = ssBuffer[addressValueIndex];
        addressValueIndex += 1;
        addressValue = ssBuffer.slice(addressValueIndex, addressValueIndex + addressLength).toString();
        break;
      case 4:
        addressLength = 16;
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
          ipv6.push(ssBuffer.readUInt16BE(addressValueIndex + i * 2).toString(16));
        }
        addressValue = ipv6.join(":");
        break;
      default:
        return { hasError: true, message: `Invalid addressType for SS: ${addressType}` };
    }

    if (!addressValue) {
      return { hasError: true, message: `Destination address empty, address type is: ${addressType}` };
    }

    const portIndex = addressValueIndex + addressLength;
    const portRemote = ssBuffer.readUInt16BE(portIndex);
    return {
      hasError: false,
      addressRemote: addressValue,
      addressType: addressType,
      portRemote: portRemote,
      rawDataIndex: portIndex + 2,
      rawClientData: ssBuffer.slice(portIndex + 2),
      version: null,
      isUDP: portRemote == 53,
    };
  }

  readFlashHeader(buffer) {
    const version = buffer[0];
    let isUDP = false;

    const optLength = buffer[17];
    const cmd = buffer[18 + optLength];
    
    if (cmd === 2) {
      isUDP = true;
    } else if (cmd !== 1) {
      return { hasError: true, message: `command ${cmd} is not supported` };
    }
    
    const portIndex = 18 + optLength + 1;
    const portRemote = buffer.readUInt16BE(portIndex);

    let addressIndex = portIndex + 2;
    const addressType = buffer[addressIndex];
    
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = "";
    
    switch (addressType) {
      case 1:
        addressLength = 4;
        addressValue = Array.from(buffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".");
        break;
      case 2:
        addressLength = buffer[addressValueIndex];
        addressValueIndex += 1;
        addressValue = buffer.slice(addressValueIndex, addressValueIndex + addressLength).toString();
        break;
      case 3:
        addressLength = 16;
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
          ipv6.push(buffer.readUInt16BE(addressValueIndex + i * 2).toString(16));
        }
        addressValue = ipv6.join(":");
        break;
      default:
        return { hasError: true, message: `invalid addressType is ${addressType}` };
    }
    
    if (!addressValue) {
      return { hasError: true, message: `addressValue is empty, addressType is ${addressType}` };
    }

    return {
      hasError: false,
      addressRemote: addressValue,
      addressType: addressType,
      portRemote: portRemote,
      rawDataIndex: addressValueIndex + addressLength,
      rawClientData: buffer.slice(addressValueIndex + addressLength),
      version: Buffer.from([version, 0]),
      isUDP: isUDP,
    };
  }

  readHorseHeader(buffer) {
    const dataBuffer = buffer.slice(58);
    if (dataBuffer.length < 6) {
      return { hasError: true, message: "invalid request data" };
    }

    let isUDP = false;
    const cmd = dataBuffer[0];
    if (cmd == 3) {
      isUDP = true;
    } else if (cmd != 1) {
      throw new Error("Unsupported command type!");
    }

    let addressType = dataBuffer[1];
    let addressLength = 0;
    let addressValueIndex = 2;
    let addressValue = "";
    
    switch (addressType) {
      case 1:
        addressLength = 4;
        addressValue = Array.from(dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".");
        break;
      case 3:
        addressLength = dataBuffer[addressValueIndex];
        addressValueIndex += 1;
        addressValue = dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength).toString();
        break;
      case 4:
        addressLength = 16;
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
          ipv6.push(dataBuffer.readUInt16BE(addressValueIndex + i * 2).toString(16));
        }
        addressValue = ipv6.join(":");
        break;
      default:
        return { hasError: true, message: `invalid addressType is ${addressType}` };
    }

    if (!addressValue) {
      return { hasError: true, message: `address is empty, addressType is ${addressType}` };
    }

    const portIndex = addressValueIndex + addressLength;
    const portRemote = dataBuffer.readUInt16BE(portIndex);
    return {
      hasError: false,
      addressRemote: addressValue,
      addressType: addressType,
      portRemote: portRemote,
      rawDataIndex: portIndex + 4,
      rawClientData: dataBuffer.slice(portIndex + 4),
      version: null,
      isUDP: isUDP,
    };
  }

  remoteSocketToWS(remoteSocket, webSocket, responseHeader, retry, log) {
    let header = responseHeader;
    let hasIncomingData = false;

    remoteSocket.on('data', (chunk) => {
      hasIncomingData = true;
      if (webSocket.readyState !== WS_READY_STATE_OPEN) {
        remoteSocket.destroy();
        return;
      }
      if (header) {
        const combined = Buffer.concat([Buffer.from(header), chunk]);
        webSocket.send(combined);
        header = null;
      } else {
        webSocket.send(chunk);
      }
    });

    remoteSocket.on('close', () => {
      if (hasIncomingData === false && retry) {
        retry();
      }
    });

    remoteSocket.on('error', (error) => {
      console.error(`remoteSocket error:`, error);
    });
  }

  // ==================== SERVER START ====================

  start(port = process.env.PORT || 3000) {
    const server = http.createServer((req, res) => {
      this.handleHttpRequest(req, res).catch(error => {
        console.error('HTTP handler error:', error);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      });
    });

    this.wss = new WebSocket.Server({ 
      server,
      perMessageDeflate: false
    });

    this.wss.on('connection', (ws, req) => {
      this.handleWebSocketConnection(ws, req);
    });

    const gracefulShutdown = () => {
      console.log('Shutting down gracefully...');
      if (this.wss) {
        this.wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.close();
          }
        });
        this.wss.close();
      }
      
      // AMAN: Bersihkan koneksi UDP dengan proteksi catch error
      for (const [key, connection] of this.activeUDPConnections.entries()) {
        try {
          connection.socket.close();
        } catch (err) {
          // Abaikan jika socket sudah ditutup sebelumnya
        }
      }
      this.activeUDPConnections.clear();
      
      if (this.httpServer) {
        this.httpServer.close(() => {
          console.log('HTTP server closed');
          process.exit(0);
        });
      }
      setTimeout(() => { process.exit(1); }, 10000);
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);

    server.listen(port, '0.0.0.0', () => {
      console.log(`✅ Gateway server running on port ${port}`);
    });

    this.httpServer = server;
    
    server.on('error', (error) => {
      console.error('Server error:', error);
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use`);
        process.exit(1);
      }
    });
  }
}

if (require.main === module) {
  const server = new GatewayServer();
  try {
    require('dotenv').config();
  } catch (e) {}
  const port = process.env.PORT || 3000;
  server.start(port);
}

module.exports = GatewayServer;
