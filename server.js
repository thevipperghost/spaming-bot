const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static assets from the current directory
app.use(express.static(__dirname));
app.use(express.json({ limit: '1mb' }));

// ------------------------------------------------------------------
// Explicit Root Route (Fixes the "Cannot GET /" error)
// ------------------------------------------------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Store the WhatsApp session
const AUTH_PATH = path.join(process.env.LOCALAPPDATA || __dirname, 'wwebjs_auth');

// ------------------------------------------------------------------
// WhatsApp client setup
// ------------------------------------------------------------------
let client = null;
let clientReady = false;
let latestQr = null;
let restartTimer = null;
let restartDelay = 5000;

function killOrphanedBrowsers() {
  if (process.platform !== 'win32') return;
  try {
    execSync(
      `powershell -NoProfile -Command "Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\\.cache\\puppeteer*' } | Stop-Process -Force"`,
      { stdio: 'ignore' }
    );
  } catch (e) { /* ignore */ }
}

function cleanupStaleLocks() {
  killOrphanedBrowsers();
  const sessionDir = path.join(AUTH_PATH, 'session');
  if (!fs.existsSync(sessionDir)) return;
  ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']
    .forEach((f) => {
      try { fs.unlinkSync(path.join(sessionDir, f)); } catch (e) { /* ignore */ }
    });
}

function createClient() {
  clientReady = false;
  latestQr = null;

  const c = new Client({
    authStrategy: new LocalAuth({
      dataPath: AUTH_PATH
    }),
    authTimeoutMs: 180000,
    puppeteer: {
      headless: true,
      timeout: 240000,
      protocolTimeout: 240000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-features=Translate'
      ]
    }
  });

  let readyFired = false;

  c.on('qr', (qr) => {
    latestQr = qr;
    console.log('\n==============================================');
    console.log('  Scan this QR code to link your WhatsApp:');
    console.log('  Phone > WhatsApp > Linked Devices > Link a Device');
    console.log('==============================================');
    qrcode.generate(qr, { small: true });
  });

  c.on('ready', () => {
    if (readyFired) return;
    readyFired = true;
    clientReady = true;
    restartDelay = 5000;
    console.log('[WhatsApp] Client is ready! Session saved.');
  });

  c.on('auth_failure', (msg) => {
    console.error('[WhatsApp] Authentication failed:', msg);
    clientReady = false;
    scheduleRestart();
  });

  c.on('disconnected', (reason) => {
    console.log('[WhatsApp] Client disconnected:', reason);
    clientReady = false;
    scheduleRestart();
  });

  c.initialize().catch((err) => {
    const msg = err && err.message ? err.message : String(err);
    console.error('[WhatsApp] Failed to initialize client:', msg);
    scheduleRestart();
  });

  return c;
}

function scheduleRestart() {
  if (restartTimer) return;
  const delay = restartDelay;
  restartDelay = Math.min(restartDelay * 2, 30000);
  console.log(`[WhatsApp] Restarting client in ${(delay / 1000).toFixed(0)}s...`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    cleanupStaleLocks();
    client = createClient();
  }, delay);
}

cleanupStaleLocks();
client = createClient();

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err.message);
  clientReady = false;
  scheduleRestart();
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection:', reason && reason.message ? reason.message : reason);
});

// ------------------------------------------------------------------
// API Routes
// ------------------------------------------------------------------
app.get('/api/status', (req, res) => {
  res.json({ ready: clientReady });
});

app.get('/api/qr', async (req, res) => {
  try {
    if (!latestQr || clientReady) {
      return res.json({ qr: null });
    }
    const dataUrl = await QRCode.toDataURL(latestQr, { width: 280, margin: 1 });
    res.json({ qr: dataUrl });
  } catch (err) {
    res.status(500).json({ qr: null, error: err.message });
  }
});

app.post('/send-bulk-message', async (req, res) => {
  const { numbers, message } = req.body || {};

  if (!Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ success: false, error: 'Please provide a non-empty array of numbers.' });
  }

  if (typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ success: false, error: 'Please provide a message.' });
  }

  if (!clientReady) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp is not connected yet. Scan the QR code shown on the page.'
    });
  }

  const results = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let i = 0; i < numbers.length; i++) {
    const raw = String(numbers[i]).trim();
    const number = raw.replace(/\D/g, '');

    const item = { number: raw || number, status: 'failed', error: '' };

    if (!number || number.length < 10) {
      item.error = 'Invalid number format or missing country code.';
      results.push(item);
      continue;
    }

    try {
      let chatId = number + '@c.us';
      try {
        const wid = await client.getNumberId(number);
        if (wid && wid._serialized) {
          chatId = wid._serialized;
        }
      } catch (e) { /* fallback to default */ }

      await client.sendMessage(chatId, message);
      item.status = 'sent';
    } catch (err) {
      item.error = err && err.message ? err.message : String(err);
    }

    results.push(item);

    if (i < numbers.length - 1) {
      await sleep(1000 + Math.floor(Math.random() * 2000));
    }
  }

  const sent = results.filter((r) => r.status === 'sent').length;
  res.json({
    success: true,
    total: numbers.length,
    sent,
    failed: results.length - sent,
    results
  });
});

app.listen(PORT, () => {
  console.log(`[Server] Running at http://localhost:${PORT}`);
});
