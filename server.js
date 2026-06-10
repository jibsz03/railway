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
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>⚡ J1BTNL // GENERATOR SNI ⚡</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700;800&display=swap');
    
    * {
      font-family: 'JetBrains Mono', monospace;
    }
    
    body {
      background: radial-gradient(circle at 20% 30%, #001a00, #000000);
      background-attachment: fixed;
    }
    
    .cyber-grid {
      background-image: 
        linear-gradient(rgba(0, 255, 100, 0.05) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0, 255, 100, 0.05) 1px, transparent 1px);
      background-size: 40px 40px;
    }
    
    .glow-green {
      box-shadow: 0 0 15px rgba(0, 255, 100, 0.5), inset 0 0 5px rgba(0, 255, 100, 0.2);
    }
    .glow-lightgreen {
      box-shadow: 0 0 12px rgba(50, 255, 120, 0.6);
    }
    
    .neon-border-green {
      border: 1px solid rgba(0, 255, 100, 0.5);
      transition: all 0.2s;
    }
    .neon-border-green:hover {
      border-color: #00ff66;
      box-shadow: 0 0 12px #00ff66;
    }
    
    .neon-border-lime {
      border: 1px solid rgba(100, 255, 80, 0.5);
    }
    .neon-border-lime:hover {
      border-color: #6eff00;
      box-shadow: 0 0 12px #6eff00;
    }
    
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #0a1f0a; }
    ::-webkit-scrollbar-thumb { background: #00ff66; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #33ff99; }
    
    @keyframes glitch {
      0% { text-shadow: -2px 0 #00ff66, 2px 0 #00cc44; }
      50% { text-shadow: 2px 0 #00ff66, -2px 0 #00cc44; }
      100% { text-shadow: -2px 0 #00ff66, 2px 0 #00cc44; }
    }
    .glitch-text {
      animation: glitch 1.5s infinite ease-in-out;
    }
    
    .dark-glass {
      background: rgba(0, 20, 5, 0.7);
      backdrop-filter: blur(4px);
      border: 1px solid rgba(0, 255, 100, 0.3);
    }
    
    input, select {
      background: #051005;
      border: 1px solid #00aa44;
      color: #ccffdd;
    }
    input:focus, select:focus {
      border-color: #00ff66;
      outline: none;
      box-shadow: 0 0 8px #00ff66;
    }
    
    button {
      transition: 0.2s;
    }
    button:active {
      transform: scale(0.96);
    }
  </style>
</head>
<body class="text-green-200 cyber-grid min-h-screen flex flex-col">

  <!-- HEADER DENGAN LOGO PETIR -->
  <header class="border-b border-green-900/60 bg-black/80 backdrop-blur-md sticky top-0 z-50 px-6 py-4">
    <div class="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <div class="h-12 w-12 rounded-lg bg-green-600/20 border border-green-500/60 flex items-center justify-center text-green-400 glow-green animate-pulse">
          <i class="fa-solid fa-bolt text-xl"></i>
        </div>
        <div>
          <h1 class="text-2xl font-black tracking-wider text-white glitch-text">J1BTNL<span class="text-green-400">.gate</span></h1>
        </div>
      </div>
      <div class="flex items-center gap-4">
        <div class="flex items-center gap-2 bg-black/60 neon-border-green px-5 py-2 rounded-full">
          <span class="h-2.5 w-2.5 rounded-full bg-green-500 glow-green animate-ping"></span>
          <span class="text-xs font-bold text-green-400 tracking-wider">⚡ CORE ACTIVE</span>
        </div>
      </div>
    </div>
  </header>

  <main class="max-w-7xl w-full mx-auto p-6 space-y-8 flex-grow">

    <!-- STATISTIK CARD: UPTIME, RAM, BANDWIDTH TERPAKAI, NODE VERSION -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-5">
      <div class="dark-glass rounded-xl p-5 flex items-center justify-between neon-border-green">
        <div><p class="text-xs text-green-400 font-bold mb-1">UPTIME</p><p id="uptime-val" class="text-2xl font-black text-white">0s</p></div>
        <i class="fa-solid fa-hourglass-half text-3xl text-green-800/60"></i>
      </div>
      <div class="dark-glass rounded-xl p-5 flex items-center justify-between neon-border-lime">
        <div><p class="text-xs text-green-400 font-bold mb-1">RAM HUNGER</p><p class="text-2xl font-black text-white">${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB</p></div>
        <i class="fa-solid fa-microchip text-3xl text-green-800/60"></i>
      </div>
      <!-- BANDWIDTH TERPAKAI (simulasi dinamis) -->
      <div class="dark-glass rounded-xl p-5 flex items-center justify-between neon-border-green">
        <div><p class="text-xs text-green-400 font-bold mb-1">BANDWIDTH TERPAKAI</p><p id="bandwidth-val" class="text-xl font-bold text-green-400">0 MB</p></div>
        <i class="fa-solid fa-chart-line text-3xl text-green-700/50"></i>
      </div>
      <div class="dark-glass rounded-xl p-5 flex items-center justify-between neon-border-lime">
        <div><p class="text-xs text-green-400 font-bold mb-1">NODE CORE</p><p class="text-xl font-bold text-green-300">${process.version}</p></div>
        <i class="fa-brands fa-node-js text-3xl text-green-800/60"></i>
      </div>
    </div>

    <!-- ========== HANYA VLESS / TROJAN GENERATOR ========== -->
    <div class="dark-glass rounded-xl p-6 space-y-5 neon-border-lime">
      <div class="flex items-center gap-3 border-b border-green-900/60 pb-3">
        <i class="fa-solid fa-key text-yellow-400 text-xl"></i>
        <h2 class="text-md font-black tracking-wider text-white">🔑 VLESS / TROJAN GENERATOR (UNLIMITED)</h2>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <!-- INPUT SECTION -->
        <div class="space-y-4">
          <div><label class="text-xs text-green-400 font-bold block mb-1">UUID / PASSWORD</label><div class="flex gap-2"><input id="uuidInput" type="text" value="853b8456-0c0b-4bfa-b3b4-b2619248a9bc" class="w-full bg-black/80 border border-green-700 rounded-lg px-3 py-2 text-sm text-green-200"><button id="randomUuidBtn" class="bg-green-900/40 border border-green-600 text-green-300 hover:bg-green-700 px-3 py-2 rounded-lg text-xs"><i class="fa-solid fa-shuffle"></i> RANDOM</button></div></div>
          <div><label class="text-xs text-green-400 font-bold block mb-1">HOST / DOMAIN</label><input id="hostInput" type="text" value="${currentHost}" class="w-full bg-black/80 border border-green-700 rounded-lg px-3 py-2 text-sm text-green-200"></div>
          <div><label class="text-xs text-green-400 font-bold block mb-1">PORT</label><input id="portInput" type="text" value="443" class="w-full bg-black/80 border border-green-700 rounded-lg px-3 py-2 text-sm text-green-200"></div>
          <div><label class="text-xs text-green-400 font-bold block mb-1">PATH</label><div class="flex gap-2"><select id="pathSelect" class="bg-black/80 border border-green-700 rounded-lg px-3 py-2 text-sm text-green-200"><option value="/ALL">🌍 /ALL</option><option value="/ID">🇮🇩 /ID</option><option value="/SG">🇸🇬 /SG</option><option value="/JP">🇯🇵 /JP</option><option value="/US">🇺🇸 /US</option><option value="/ASIA">🌏 /ASIA</option><option value="/EUROPE">🇪🇺 /EUROPE</option><option value="/AMERICA">🌎 /AMERICA</option><option value="/PROXYLIST/ID,SG,JP">🔀 /PROXYLIST</option><option value="/PUTAR">🎰 /PUTAR</option></select><input id="pathInput" type="text" value="/ALL" class="w-full bg-black/80 border border-green-700 rounded-lg px-3 py-2 text-sm text-green-200"></div></div>
          <div><label class="text-xs text-green-400 font-bold block mb-1"><i class="fa-solid fa-fingerprint"></i> SNI (CUSTOM)</label><div class="flex gap-2"><select id="sniSelect" class="bg-black/80 border border-green-700 rounded-lg px-3 py-2 text-sm"><option value="business.whatsapp.com">📱 business.whatsapp.com</option><option value="media-sin6-3.cdn.whatsapp.net">📡 media-sin6-3</option><option value="c.whatsapp.com">💬 c.whatsapp.com</option><option value="web.whatsapp.com">🌐 web.whatsapp.com</option><option value="v.whatsapp.net">📞 v.whatsapp.net</option><option value="custom">✏️ CUSTOM</option></select><input id="sniInput" type="text" value="business.whatsapp.com" class="w-full bg-black/80 border border-green-700 rounded-lg px-3 py-2 text-sm text-green-200"></div><p class="text-[10px] text-green-700">Pilih preset atau ketik manual</p></div>
          <div><label class="text-xs text-green-400 font-bold block mb-1">REMARK / NAMA</label><input id="remarkInput" type="text" value="J1BTNL" class="w-full bg-black/80 border border-green-700 rounded-lg px-3 py-2 text-sm text-green-200"></div>
          <button id="generateBtn" class="w-full bg-gradient-to-r from-green-700 to-lime-700 hover:from-green-600 hover:to-lime-600 text-white font-bold py-3 rounded-lg text-sm flex justify-center gap-2 shadow-lg"><i class="fa-solid fa-bolt"></i> GENERATE ACCOUNTS</button>
        </div>

        <!-- OUTPUT SECTION -->
        <div class="space-y-3">
          <div class="bg-black/60 rounded-lg p-4 border border-green-700"><div class="flex justify-between mb-2"><span class="text-[10px] bg-green-600/40 text-green-300 px-2 py-0.5 rounded font-bold">VLESS LINK</span><button onclick="copyText(document.getElementById('vlessOutput').innerText)" class="text-xs bg-green-900/40 border border-green-700 text-green-300 hover:bg-green-800 px-2 py-1 rounded"><i class="fa-regular fa-copy"></i> COPY</button></div><p id="vlessOutput" class="text-xs text-green-200 font-mono break-all bg-black/80 p-2 rounded">Loading...</p></div>
          <div class="bg-black/60 rounded-lg p-4 border border-lime-700"><div class="flex justify-between mb-2"><span class="text-[10px] bg-lime-600/40 text-lime-300 px-2 py-0.5 rounded font-bold">TROJAN LINK</span><button onclick="copyText(document.getElementById('trojanOutput').innerText)" class="text-xs bg-green-900/40 border border-green-700 text-green-300 hover:bg-green-800 px-2 py-1 rounded"><i class="fa-regular fa-copy"></i> COPY</button></div><p id="trojanOutput" class="text-xs text-lime-200 font-mono break-all bg-black/80 p-2 rounded">Loading...</p></div>
          <div class="bg-black/70 border border-green-700 rounded-lg p-3"><p class="text-[10px] text-green-400 mb-1">⚔️ CLASH META / V2RAY FORMAT</p><pre id="clashOutput" class="text-[11px] text-green-300 font-mono whitespace-pre-wrap bg-black/90 p-2 rounded max-h-48 overflow-y-auto">Loading...</pre></div>
        </div>
      </div>
    </div>

  </main>

  <footer class="border-t border-green-950 bg-black/80 px-6 py-4 text-center text-xs text-green-800">
    <div class="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
      <p>⚡ J1BTNL — CHANNEL @J1BTNL | DEVILS WILL RISE</p>
      <p><i class="fa-solid fa-bolt"></i> TANPA BATAS • TANPA FILTER</p>
    </div>
  </footer>

  <div id="toast" class="fixed bottom-6 right-6 bg-green-700 text-white font-bold px-5 py-3 rounded-lg shadow-2xl opacity-0 pointer-events-none transition-all duration-300 text-xs z-50 flex items-center gap-2 border border-green-500"><i class="fa-solid fa-bolt"></i> COPIED TO CLIPBOARD</div>

  <script>
    // ========== SEMUA FUNGSI TETAP SAMA PERSIS + BANDWIDTH SIMULASI ==========
    function copyText(text) {
      navigator.clipboard.writeText(text).then(() => {
        const toast = document.getElementById('toast');
        toast.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-2');
        toast.classList.add('opacity-100', 'translate-y-0');
        setTimeout(() => {
          toast.classList.remove('opacity-100', 'translate-y-0');
          toast.classList.add('opacity-0', 'pointer-events-none', 'translate-y-2');
        }, 2500);
      });
    }

    let start = ${Math.floor(process.uptime())};
    setInterval(() => {
      start++;
      document.getElementById('uptime-val').innerText = start + 's';
    }, 1000);

    // Simulasi bandwidth terpakai (random naik turun)
    let bandwidthMB = 0;
    setInterval(() => {
      bandwidthMB = Math.min(2048, bandwidthMB + Math.floor(Math.random() * 20));
      if (bandwidthMB > 2000) bandwidthMB = 200;
      document.getElementById('bandwidth-val').innerText = bandwidthMB + ' MB';
    }, 4000);

    function generateUUID() {
      const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
      document.getElementById('uuidInput').value = uuid;
      generateAccounts();
    }

    function generateTrojanPass() {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let pass = '';
      for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) {
          pass += '-';
        } else {
          pass += chars.charAt(Math.floor(Math.random() * chars.length));
        }
      }
      return pass;
    }

    function generateAccounts() {
      try {
        const uuidEl = document.getElementById('uuidInput');
        const hostEl = document.getElementById('hostInput');
        const portEl = document.getElementById('portInput');
        const pathEl = document.getElementById('pathInput');
        const sniEl = document.getElementById('sniInput');
        const remarkEl = document.getElementById('remarkInput');
        const vlessOut = document.getElementById('vlessOutput');
        const trojanOut = document.getElementById('trojanOutput');
        const clashOut = document.getElementById('clashOutput');

        if (!uuidEl || !hostEl || !portEl || !pathEl || !sniEl || !remarkEl || !vlessOut || !trojanOut || !clashOut) {
          console.log('Generator: Waiting for DOM...');
          return;
        }

        const uuid = uuidEl.value.trim() || '853b8456-0c0b-4bfa-b3b4-b2619248a9bc';
        const host = hostEl.value.trim() || '${currentHost}';
        const port = portEl.value.trim() || '443';
        const path = pathEl.value.trim() || '/ALL';
        const sni = sniEl.value.trim() || 'business.whatsapp.com';
        const remark = remarkEl.value.trim() || 'J1BTNL';

        const encodedPath = encodeURIComponent(path);
        const encodedRemark = encodeURIComponent(remark);

        const vlessUrl = 'vless://' + uuid + '@' + host + ':' + port +
                         '?encryption=none&security=tls&sni=' + sni +
                         '&fp=randomized&type=ws&host=' + host +
                         '&path=' + encodedPath + '#' + encodedRemark;

        const trojanPass = generateTrojanPass();
        const trojanUrl = 'trojan://' + trojanPass + '@' + host + ':' + port +
                          '?sni=' + sni +
                          '&type=ws&host=' + host +
                          '&path=' + encodedPath + '#' + encodedRemark;

        vlessOut.textContent = vlessUrl;
        trojanOut.textContent = trojanUrl;

        const clashConfig = '- name: "' + remark + ' VLESS"\\n' +
                            '  type: vless\\n' +
                            '  server: ' + host + '\\n' +
                            '  port: ' + port + '\\n' +
                            '  uuid: ' + uuid + '\\n' +
                            '  network: ws\\n' +
                            '  tls: true\\n' +
                            '  udp: true\\n' +
                            '  sni: "' + sni + '"\\n' +
                            '  client-fingerprint: randomized\\n' +
                            '  ws-opts:\\n' +
                            '    path: "' + path + '"\\n' +
                            '    headers:\\n' +
                            '      host: "' + host + '"\\n\\n' +
                            '- name: "' + remark + ' TROJAN"\\n' +
                            '  type: trojan\\n' +
                            '  server: ' + host + '\\n' +
                            '  port: ' + port + '\\n' +
                            '  password: ' + trojanPass + '\\n' +
                            '  network: ws\\n' +
                            '  tls: true\\n' +
                            '  udp: true\\n' +
                            '  sni: "' + sni + '"\\n' +
                            '  ws-opts:\\n' +
                            '    path: "' + path + '"\\n' +
                            '    headers:\\n' +
                            '      host: "' + host + '"';

        clashOut.textContent = clashConfig;
      } catch (err) {
        console.error('Generator Error:', err);
      }
    }

    setTimeout(function() { generateAccounts(); }, 300);

    setTimeout(function() {
      const elements = ['uuidInput', 'hostInput', 'portInput', 'pathInput', 'sniInput', 'remarkInput'];
      elements.forEach(function(id) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', generateAccounts);
      });
      const pathSelect = document.getElementById('pathSelect');
      if (pathSelect) {
        pathSelect.addEventListener('change', function() {
          const pathInput = document.getElementById('pathInput');
          if (pathInput) { pathInput.value = this.value; generateAccounts(); }
        });
      }
      const sniSelect = document.getElementById('sniSelect');
      if (sniSelect) {
        sniSelect.addEventListener('change', function() {
          const sniInput = document.getElementById('sniInput');
          if (sniInput) {
            if (this.value === 'custom') sniInput.value = '';
            else { sniInput.value = this.value; generateAccounts(); }
          }
        });
      }
      const genBtn = document.getElementById('generateBtn');
      if (genBtn) genBtn.addEventListener('click', function(e) { e.preventDefault(); generateAccounts(); });
      const randBtn = document.getElementById('randomUuidBtn');
      if (randBtn) randBtn.addEventListener('click', function(e) { e.preventDefault(); generateUUID(); });
    }, 600);
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
      
      for (const [key, connection] of this.activeUDPConnections.entries()) {
        try {
          connection.socket.close();
        } catch (err) {}
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
