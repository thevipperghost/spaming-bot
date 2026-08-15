const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// Store the WhatsApp session OUTSIDE the OneDrive project folder.
// A Chromium profile inside OneDrive causes file-lock conflicts and
// timeouts. LOCALAPPDATA is local to the PC, fast and never synced.
const AUTH_PATH = path.join(process.env.LOCALAPPDATA || __dirname, 'wwebjs_auth');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

// ------------------------------------------------------------------
// WhatsApp client setup (with auto-restart so the site never dies)
// ------------------------------------------------------------------
let client = null;
let clientReady = false;
let latestQr = null;
let restartTimer = null;
let restartDelay = 5000;

function killOrphanedBrowsers() {
  // A failed launch can leave a hung Chromium (from the puppeteer cache)
  // holding the session folder, making every retry fail with
  // "browser is already running". Kill only puppeteer's Chromium,
  // never the user's own Chrome browser.
  try {
    execSync(
      `powershell -NoProfile -Command "Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\\.cache\\puppeteer*' } | Stop-Process -Force"`,
      { stdio: 'ignore' }
    );
  } catch (e) { /* ignore */ }
}

function cleanupStaleLocks() {
  // If the browser crashed, it can leave lock files that make the next
  // launch fail with "browser is already running". Remove them safely.
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
      dataPath: AUTH_PATH // session is saved here so you scan the QR only once
    }),
    // Give a slow machine time to load WhatsApp Web (default is 30s,
    // which is too short and aborts with "auth timeout").
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
    console.log('  (QR is also shown on the web page)');
    console.log('==============================================');
    qrcode.generate(qr, { small: true });
    console.log('');
  });

  c.on('ready', () => {
    if (readyFired) return;
    readyFired = true;
    clientReady = true;
    restartDelay = 5000;
    console.log('[WhatsApp] Client is ready! Session saved. You can now send messages.');
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
  restartDelay = Math.min(restartDelay * 2, 30000); // backoff: 5s -> 30s max
  console.log(`[WhatsApp] Restarting client in ${(delay / 1000).toFixed(0)}s...`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    cleanupStaleLocks();
    client = createClient();
  }, delay);
}

cleanupStaleLocks();
client = createClient();

// Keep the web server alive even if the WhatsApp client crashes
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception (site keeps running):', err.message);
  clientReady = false;
  scheduleRestart();
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection (site keeps running):',
    reason && reason.message ? reason.message : reason);
});

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------
// GET /api/status  -> lets the frontend show connection state
// ------------------------------------------------------------------
app.get('/api/status', (req, res) => {
  res.json({ ready: clientReady });
});

// ------------------------------------------------------------------
// GET /api/qr  -> sends the QR code as an image (data URL) so the
//                 browser can show it instead of the terminal
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// POST /send-bulk-message
// Body: { numbers: ["+1234567890", ...], message: "Hello" }
// ------------------------------------------------------------------
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
      error: 'WhatsApp is not connected yet. Scan the QR code shown on the page or in the terminal.'
    });
  }

  const results = [];

  // Sequential loop with a randomized 1-3s delay between sends.
  // This keeps the sends spaced out so WhatsApp does not flag the
  // session as spam, even though the whole batch is one request.
  for (let i = 0; i < numbers.length; i++) {
    const raw = String(numbers[i]).trim();
    const number = raw.replace(/\D/g, ''); // keep digits only

    const item = { number: raw || number, status: 'failed', error: '' };

    if (!number) {
      item.error = 'Invalid number';
      results.push(item);
      continue;
    }
    if (number.length < 10) {
      item.error = 'Number is missing the country code. Use full format like +919137819535 or +14155552671';
      results.push(item);
      continue;
    }

    try {
      // Try to resolve a real WhatsApp ID for the number first. If the
      // number is not on WhatsApp (or the country code is wrong), this
      // returns null. If it resolves, we use that ID for sending.
      let chatId = number + '@c.us';
      try {
        const wid = await client.getNumberId(number);
        if (wid && wid._serialized) {
          chatId = wid._serialized;
        }
      } catch (e) {
        // getNumberId can fail sometimes - fall back to the direct ID.
      }

      const sentMsg = await client.sendMessage(chatId, message);

      if (sentMsg) {
        item.status = 'sent';
      } else {
        item.error = 'WhatsApp returned no result - the number may not be registered on WhatsApp';
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (msg.includes('No LID')) {
        item.error = 'WhatsApp cannot find this number. It is not registered on WhatsApp, or the country code is missing/wrong. Use +<countrycode><number>, e.g. +919137819535';
      } else {
        item.error = msg;
      }
    }

    console.log(`[WhatsApp] ${item.number} -> ${item.status}${item.error ? ' (' + item.error + ')' : ''}`);
    results.push(item);

    // Randomized delay of 1 to 3 seconds before the next send
    if (i < numbers.length - 1) {
      const delay = 1000 + Math.floor(Math.random() * 2000);
      console.log(`[WhatsApp] Waiting ${(delay / 1000).toFixed(1)}s before next message...`);
      await sleep(delay);
    }
  }

  const sent = results.filter((r) => r.status === 'sent').length;
  const failed = results.length - sent;

  console.log(`[WhatsApp] Batch finished -> sent: ${sent}, failed: ${failed}`);

  res.json({
    success: true,
    total: numbers.length,
    sent,
    failed,
    results
  });
});

app.listen(PORT, () => {
  console.log(`[Server] Running at http://localhost:${PORT}`);
});
