const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

// ------------------------------------------------------------------
// WhatsApp client setup
// ------------------------------------------------------------------
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: '.wwebjs_auth' // session is saved here so you scan the QR only once
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage'
    ]
  }
});

let clientReady = false;
let latestQr = null;

client.on('qr', (qr) => {
  latestQr = qr;
  console.log('\n==============================================');
  console.log('  Scan this QR code to link your WhatsApp:');
  console.log('  Phone > WhatsApp > Linked Devices > Link a Device');
  console.log('  (QR is also shown on the web page)');
  console.log('==============================================');
  qrcode.generate(qr, { small: true });
  console.log('');
});

client.on('ready', () => {
  clientReady = true;
  latestQr = null;
  console.log('[WhatsApp] Client is ready! Session saved. You can now send messages.');
});

client.on('auth_failure', (msg) => {
  console.error('[WhatsApp] Authentication failed:', msg);
  clientReady = false;
});

client.on('disconnected', (reason) => {
  console.log('[WhatsApp] Client disconnected:', reason);
  clientReady = false;
});

client.initialize().catch((err) => {
  console.error('[WhatsApp] Failed to initialize client:', err.message);
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

    try {
      // Verify the number is actually registered on WhatsApp
      const contact = await client.getNumberId(number);
      if (!contact) {
        item.error = 'Number is not registered on WhatsApp';
        results.push(item);
        continue;
      }

      await client.sendMessage(number, message);
      item.status = 'sent';
    } catch (err) {
      item.error = err.message || String(err);
    }

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
