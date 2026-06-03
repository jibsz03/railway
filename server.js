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
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Khusus Config SNI | VLESS & Trojan</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');

    * { box-sizing: border-box; }

    :root {
      color-scheme: dark;
      --line: rgba(67, 255, 218, .14);
      --text: #f7fffb;
      --muted: #9bb7b2;
      --muted2: #6f9994;
      --teal: #36f5d0;
      --violet: #b8a0ff;
      --blue: #93d8ff;
    }

    html, body {
      margin: 0;
      min-height: 100%;
      font-family: Inter, system-ui, sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at 0% 0%, rgba(31, 245, 197, .14), transparent 32%),
        radial-gradient(circle at 100% 0%, rgba(139, 92, 246, .18), transparent 34%),
        linear-gradient(135deg, #031313 0%, #041b19 45%, #061528 100%);
    }

    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(rgba(54,245,208,.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(54,245,208,.025) 1px, transparent 1px);
      background-size: 34px 34px;
      mask-image: radial-gradient(circle at top, black, transparent 76%);
    }

    button, input, a { font-family: inherit; }

    .page {
      position: relative;
      max-width: 760px;
      margin: 0 auto;
      padding: 14px;
    }

    .hero {
      position: relative;
      overflow: hidden;
      border-radius: 28px;
      padding: 28px;
      background:
        radial-gradient(circle at 0% 0%, rgba(54,245,208,.13), transparent 34%),
        radial-gradient(circle at 100% 0%, rgba(139,92,246,.20), transparent 38%),
        linear-gradient(145deg, rgba(4, 30, 28, .96), rgba(4, 18, 24, .96));
      border: 1px solid var(--line);
      box-shadow: 0 30px 90px rgba(0,0,0,.35);
    }

    .hero::after {
      content: "";
      position: absolute;
      width: 270px;
      height: 270px;
      right: -120px;
      top: -110px;
      border-radius: 999px;
      background: rgba(139, 92, 246, .22);
      filter: blur(25px);
    }

    .hero-inner {
      position: relative;
      z-index: 2;
    }

    .topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
      margin-bottom: 92px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 16px;
      min-width: 0;
    }

    .brand-icon {
      width: 62px;
      height: 62px;
      flex: 0 0 62px;
      border-radius: 20px;
      display: grid;
      place-items: center;
      color: white;
      background: linear-gradient(145deg, #26e69f 0%, #39d6c2 45%, #8c7bff 100%);
      box-shadow: 0 18px 42px rgba(54,245,208,.18);
    }

    .brand-icon i { font-size: 29px; }

    .brand small {
      display: block;
      color: var(--teal);
      font-size: 11px;
      font-weight: 900;
      letter-spacing: .32em;
      margin-bottom: 8px;
    }

    .brand h1 {
      margin: 0;
      color: #fff;
      font-size: clamp(27px, 5vw, 36px);
      line-height: 1;
      font-weight: 900;
      letter-spacing: -.065em;
    }

    .theme-btn {
      width: 32px;
      height: 48px;
      border-radius: 999px;
      border: 1px solid rgba(147,216,255,.22);
      background: rgba(6, 20, 27, .55);
      color: var(--teal);
      display: grid;
      place-items: center;
      cursor: pointer;
      margin-top: 88px;
      opacity: .9;
    }

    .hero-title {
      margin: 0;
      font-size: clamp(54px, 11vw, 78px);
      line-height: .89;
      font-weight: 900;
      letter-spacing: -.085em;
    }

    .hero-title span {
      background: linear-gradient(100deg, #27ffd1 0%, #8bdfff 42%, #bd9dff 78%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }

    .hero-desc {
      margin: 22px 0 28px;
      color: #eef8f5;
      opacity: .92;
      font-size: 20px;
      line-height: 1.45;
    }

    .box {
      border: 1px solid var(--line);
      background: rgba(3, 28, 27, .62);
      border-radius: 22px;
      padding: 18px;
    }

    .label {
      display: block;
      color: #9fdcff;
      font-size: 12px;
      font-weight: 900;
      letter-spacing: .32em;
      text-transform: uppercase;
      margin-bottom: 14px;
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .chip {
      border: 1px solid rgba(54,245,208,.25);
      background: rgba(54,245,208,.10);
      color: #8effe9;
      border-radius: 12px;
      padding: 9px 16px;
      font-size: 12px;
      font-weight: 900;
      line-height: 1;
    }

    .path-box {
      margin-top: 14px;
      border: 1px solid var(--line);
      background: rgba(5, 35, 34, .72);
      border-radius: 22px;
      padding: 20px;
      display: flex;
      align-items: center;
      gap: 18px;
    }

    .path-icon {
      width: 56px;
      height: 56px;
      flex: 0 0 56px;
      display: grid;
      place-items: center;
      border-radius: 18px;
      background: rgba(54,245,208,.08);
      border: 1px solid rgba(54,245,208,.15);
      color: #7bfff0;
      font-size: 24px;
    }

    .path-box b {
      display: block;
      color: #75fff0;
      font-size: 14px;
      font-weight: 900;
      letter-spacing: .32em;
      margin-bottom: 8px;
    }

    .path-box p {
      margin: 0;
      color: var(--muted);
      font-size: 16px;
      line-height: 1.45;
    }

    .path-box code {
      color: #fff;
      background: rgba(0, 13, 20, .55);
      border-radius: 9px;
      padding: 2px 8px;
      font-weight: 900;
      font-family: Inter, system-ui, sans-serif;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 14px;
      margin-top: 22px;
    }

    .stat {
      border: 1px solid var(--line);
      background: rgba(4, 28, 27, .72);
      border-radius: 20px;
      padding: 18px;
      min-height: 96px;
    }

    .stat p:first-child {
      margin: 0 0 16px;
      color: #fff;
      font-size: 14px;
      font-weight: 900;
      letter-spacing: .24em;
    }

    .stat p:last-child {
      margin: 0;
      font-size: 21px;
      font-weight: 900;
    }

    .dot {
      display: inline-block;
      box-shadow: 0 0 14px rgba(54,245,208,.8);
    }

    .text-emerald-300 { color: #7effd9 !important; }
    .text-rose-300 { color: #fda4af !important; }
    .bg-emerald-400 { background: #34d399 !important; }
    .bg-rose-400 { background: #fb7185 !important; }

    .panel {
      margin-top: 22px;
      border: 1px solid var(--line);
      background: rgba(4, 28, 27, .76);
      border-radius: 28px;
      padding: 24px;
      box-shadow: 0 25px 70px rgba(0,0,0,.22);
    }

    .panel-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
      margin-bottom: 24px;
    }

    .panel h2 {
      margin: 0;
      font-size: 28px;
      font-weight: 900;
      letter-spacing: -.055em;
    }

    .panel .sub {
      margin: 12px 0 0;
      color: var(--muted2);
      font-size: 17px;
      line-height: 1.4;
    }

    .btn {
      border: 1px solid rgba(54,245,208,.22);
      background: rgba(54,245,208,.11);
      color: #b7fff0;
      border-radius: 18px;
      min-height: 50px;
      padding: 0 18px;
      font-size: 14px;
      font-weight: 900;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      cursor: pointer;
      text-decoration: none;
      transition: .16s ease;
      white-space: nowrap;
    }

    .btn:active { transform: scale(.98); }

    .btn.light {
      background: rgba(255,255,255,.045);
      border-color: rgba(255,255,255,.12);
      color: #e7fffb;
    }

    .btn.violet {
      background: rgba(139,92,246,.13);
      border-color: rgba(185,160,255,.24);
      color: #dacdff;
    }

    .form-group {
      margin-bottom: 22px;
    }

    .input-row {
      display: grid;
      grid-template-columns: 1fr 66px;
      gap: 10px;
      align-items: stretch;
    }

    .input {
      width: 100%;
      min-height: 66px;
      border-radius: 20px;
      border: 1px solid rgba(147,216,255,.17);
      background: rgba(2, 18, 22, .72);
      color: #effffb;
      padding: 0 20px;
      outline: none;
      font-size: 18px;
      font-weight: 700;
    }

    .input[readonly] {
      color: #bffff4;
      cursor: default;
    }

    .input::placeholder {
      color: rgba(231,255,251,.56);
      font-weight: 500;
    }

    .copy-square {
      min-width: 66px;
      width: 66px;
      padding: 0;
      border-radius: 22px;
      font-size: 25px;
    }

    .info {
      border: 1px solid rgba(147,216,255,.12);
      background: rgba(255,255,255,.035);
      border-radius: 20px;
      padding: 22px;
      color: var(--muted);
      font-size: 18px;
      line-height: 1.6;
      margin-top: 2px;
    }

    .info i {
      color: #7bfff0;
      margin-right: 10px;
    }

    .result {
      margin-top: 22px;
      display: grid;
      gap: 14px;
    }

    .config-card {
      border: 1px solid rgba(147,216,255,.12);
      background: rgba(1, 14, 18, .62);
      border-radius: 20px;
      padding: 16px;
    }

    .config-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }

    .proto {
      border-radius: 12px;
      padding: 9px 13px;
      color: #84fff0;
      background: rgba(54,245,208,.10);
      border: 1px solid rgba(54,245,208,.18);
      font-size: 12px;
      font-weight: 900;
      letter-spacing: .08em;
    }

    .uri {
      word-break: break-all;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #b8d8d4;
      font-size: 12px;
      line-height: 1.7;
      max-height: 96px;
      overflow-y: auto;
      padding-right: 4px;
    }

    .uri::-webkit-scrollbar {
      width: 5px;
      height: 5px;
    }

    .uri::-webkit-scrollbar-thumb {
      background: rgba(54,245,208,.24);
      border-radius: 99px;
    }

    .endpoint-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-top: 18px;
    }

    .footer-note {
      text-align: center;
      color: #789f9a;
      font-size: 12px;
      margin: 18px 0 5px;
    }

    #toast {
      position: fixed;
      left: 50%;
      bottom: 18px;
      transform: translateX(-50%) translateY(14px);
      opacity: 0;
      pointer-events: none;
      transition: .2s ease;
      z-index: 50;
      border-radius: 15px;
      background: #eafffb;
      color: #05201f;
      padding: 12px 16px;
      font-size: 13px;
      font-weight: 900;
      box-shadow: 0 20px 50px rgba(0,0,0,.35);
      white-space: nowrap;
    }

    #toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    @media (max-width: 560px) {
      .page { padding: 12px; }
      .hero { border-radius: 26px; padding: 28px 28px 22px; }
      .topbar { margin-bottom: 86px; }
      .brand-icon { width: 62px; height: 62px; flex-basis: 62px; }
      .brand h1 { font-size: 28px; }
      .hero-title { font-size: 50px; }
      .hero-desc { font-size: 18px; }
      .path-box { padding: 18px; }
      .path-box p { font-size: 16px; }
      .stats { grid-template-columns: repeat(2, 1fr); }
      .stat { padding: 16px; min-height: 96px; }
      .stat p:first-child { font-size: 13px; }
      .stat p:last-child { font-size: 20px; }
      .panel { padding: 22px; border-radius: 26px; }
      .panel h2 { font-size: 26px; }
      .panel .sub { font-size: 16px; }
      .input { font-size: 17px; }
      .endpoint-grid { grid-template-columns: 1fr; }
    }

    @media (max-width: 410px) {
      .hero-title { font-size: 44px; }
      .brand h1 { font-size: 25px; }
      .stats { gap: 10px; }
      .stat { padding: 14px; }
      .panel-head { flex-direction: column; }
      .btn { width: 100%; }
      .input-row { grid-template-columns: 1fr 62px; }
      .copy-square { width: 62px; min-width: 62px; }
    }
  </style>
</head>

<body>
  <div class="page">
    <header class="hero">
      <div class="hero-inner">
        <div class="topbar">
          <div class="brand">
            <div class="brand-icon">
              <i class="fa-solid fa-shield-halved"></i>
            </div>
            <div>
              <small>J1BTNL</small>
              <h1>Khusus Config SNI</h1>
            </div>
          </div>

          <button type="button" class="theme-btn" aria-label="Tema">
            <i class="fa-regular fa-moon"></i>
          </button>
        </div>

        <h2 class="hero-title">
          <span>VPN Config</span><br>
          lifetime access.
        </h2>

        <p class="hero-desc">
          VLESS dan Trojan siap salin, bug bisa diisi untuk Host dan SNI.
        </p>

        <div class="box">
          <span class="label">Pilih Protokol</span>
          <div class="chips">
            <span class="chip">VLESS</span>
            <span class="chip">TROJAN</span>
          </div>
        </div>

        <div class="path-box">
          <div class="path-icon">
            <i class="fa-solid fa-code"></i>
          </div>
          <div>
            <b>CUSTOM PATH</b>
            <p>Tetap memakai path otomatis: <code>/ID</code></p>
          </div>
        </div>

        <section class="stats">
          <article class="stat">
            <p>STATUS</p>
            <p id="status-val" class="text-emerald-300 flex items-center gap-2">
              <span id="status-dot" class="dot h-2 w-2 rounded-full bg-emerald-400"></span>
              <span id="status-text">ONLINE</span>
            </p>
          </article>

          <article class="stat">
            <p>UPTIME</p>
            <p id="uptime-val">0s</p>
          </article>

          <article class="stat">
            <p>MEMORY</p>
            <p id="memory-val">${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB</p>
          </article>

          <article class="stat">
            <p>NODE</p>
            <p style="color:#93d8ff">${process.version}</p>
          </article>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>Buat Config</h2>
              <p class="sub">UUID otomatis untuk config.</p>
            </div>

            <button onclick="newUuid()" class="btn">
              <i class="fa-solid fa-wand-magic-sparkles"></i> Baru
            </button>
          </div>

          <div class="form-group">
            <span class="label">UUID / Password</span>
            <div class="input-row">
              <input id="uuid" class="input" readonly>
              <button onclick="copyValue('uuid')" class="btn light copy-square" aria-label="Salin UUID">
                <i class="fa-regular fa-copy"></i>
              </button>
            </div>
          </div>

          <div class="form-group">
            <span class="label">Masukkan Bug</span>
            <input id="bug" class="input" placeholder="contoh: bug.domain.com" oninput="generateConfigs()">
          </div>

          <div class="info">
            <i class="fa-solid fa-circle-info"></i>
            Address mengikuti hostname halaman. Host dan SNI memakai bug yang dimasukkan; jika kosong otomatis memakai hostname.
          </div>

          <div class="result">
            <article class="config-card">
              <div class="config-top">
                <span class="proto">VLESS</span>
                <button onclick="copyConfig('vless')" class="btn violet">
                  <i class="fa-regular fa-copy"></i> Salin
                </button>
              </div>
              <div id="vless" class="uri"></div>
            </article>

            <article class="config-card">
              <div class="config-top">
                <span class="proto">TROJAN</span>
                <button onclick="copyConfig('trojan')" class="btn">
                  <i class="fa-regular fa-copy"></i> Salin
                </button>
              </div>
              <div id="trojan" class="uri"></div>
            </article>
          </div>

          <div class="endpoint-grid">
            <a class="btn light" href="${protocolHttp}://${currentHost}/api/proxies" target="_blank">Proxy API</a>
            <a class="btn light" href="${protocolHttp}://${currentHost}/health" target="_blank">Health</a>
            <button class="btn light" onclick="copyAll()">Salin Semua</button>
          </div>
        </section>
      </div>
    </header>

    <p class="footer-note">Port 443, TLS, dan WS dibuat otomatis agar config tetap simpel.</p>
  </div>

  <div id="toast">
    <i class="fa-solid fa-circle-check" style="color:#059669;margin-right:7px"></i>
    <span id="toastText">Tersalin</span>
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
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 3 | 8);
        return v.toString(16);
      });
    }

    function activeHost() {
      return window.location.hostname || 'localhost';
    }

    function cleanBug(value) {
      return String(value || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*$/, '');
    }

    function formatUptime(total) {
      const days = Math.floor(total / 86400);
      total %= 86400;

      const hours = Math.floor(total / 3600);
      total %= 3600;

      const minutes = Math.floor(total / 60);
      const seconds = total % 60;

      if (days) return days + 'd ' + hours + 'h ' + minutes + 'm';
      if (hours) return hours + 'h ' + minutes + 'm ' + seconds + 's';
      if (minutes) return minutes + 'm ' + seconds + 's';
      return seconds + 's';
    }

    function renderUptime() {
      document.getElementById('uptime-val').textContent = formatUptime(Math.max(0, Math.floor(uptimeSeconds)));
    }

    function renderMemory(bytes) {
      const value = Number(bytes);
      document.getElementById('memory-val').textContent = Number.isFinite(value)
        ? Math.round(value / 1024 / 1024) + ' MB'
        : '-- MB';
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

        if (!response.ok) {
          throw new Error('health request failed');
        }

        const data = await response.json();

        if (Number.isFinite(Number(data.uptime))) {
          uptimeSeconds = Number(data.uptime);
        }

        if (data.memory && data.memory.heapUsed !== undefined) {
          renderMemory(data.memory.heapUsed);
        }

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
      const bug = cleanBug(document.getElementById('bug').value);

      const address = activeHost();
      const hostSni = bug || address;

      const encodedHost = encodeURIComponent(hostSni);
      const encodedPath = encodeURIComponent(FIXED_PATH);

      const common =
        'security=' + FIXED_SECURITY +
        '&type=ws' +
        '&host=' + encodedHost +
        '&path=' + encodedPath +
        '&sni=' + encodedHost +
        '&fp=random';

      document.getElementById('vless').textContent =
        'vless://' + uuid + '@' + address + ':' + FIXED_PORT +
        '?encryption=none&' + common +
        '#J1BTNL%20VLESS';

      document.getElementById('trojan').textContent =
        'trojan://' + uuid + '@' + address + ':' + FIXED_PORT +
        '?' + common +
        '#J1BTNL%20TROJAN';
    }

    function newUuid() {
      document.getElementById('uuid').value = randomUuid();
      generateConfigs();
      showToast('UUID baru dibuat');
    }

    function putClipboard(text, message) {
      navigator.clipboard.writeText(text).then(function() {
        showToast(message);
      }).catch(function() {
        showToast('Gagal menyalin');
      });
    }

    function copyValue(id) {
      putClipboard(document.getElementById(id).value, 'UUID disalin');
    }

    function copyConfig(id) {
      putClipboard(document.getElementById(id).textContent, id.toUpperCase() + ' disalin');
    }

    function copyAll() {
      putClipboard(
        document.getElementById('vless').textContent + '\n' +
        document.getElementById('trojan').textContent,
        'Semua config disalin'
      );
    }

    function showToast(message) {
      const toast = document.getElementById('toast');
      document.getElementById('toastText').textContent = message;

      toast.classList.add('show');
      clearTimeout(window.toastTimer);

      window.toastTimer = setTimeout(function() {
        toast.classList.remove('show');
      }, 1900);
    }

    document.getElementById('uuid').value = randomUuid();

    renderUptime();
    renderStatus(true);
    generateConfigs();
    refreshStats();

    setInterval(function() {
      uptimeSeconds++;
      renderUptime();
    }, 1000);

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
