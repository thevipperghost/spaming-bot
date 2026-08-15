# WhatsApp Bulk Message Sender

A college-project web app that sends one WhatsApp message to multiple numbers at once.
It uses the free `whatsapp-web.js` library and connects through your own WhatsApp account
by scanning a QR code in the terminal.

## Files

| File          | Purpose                                                          |
| ------------- | ---------------------------------------------------------------- |
| `index.html`  | Frontend: form, CSS, vanilla JS using `fetch()` + `preventDefault()` |
| `server.js`   | Backend: Express server with `POST /send-bulk-message`           |
| `package.json`| Dependencies to install                                          |

## Requirements

- Node.js **v18 or newer** (download from https://nodejs.org)
- A phone with WhatsApp (your personal account is used to send)

## Step-by-step run instructions

### 1. Install Node.js
Download and install Node.js LTS from https://nodejs.org.
Verify it works in a terminal (PowerShell / CMD):
```
node -v
npm -v
```

### 2. Set up the project
Open a terminal and go into this folder:
```
cd "C:\Users\HP\OneDrive\Documents\Default Project\whatsapp-bulk-sender"
```

Install the dependencies:
```
npm install
```
> On the first run `whatsapp-web.js` may also download Chromium (used to run WhatsApp Web).
> This can take a few minutes and needs an internet connection.

### 3. Start the server
```
npm start
```
You should see output like:
```
[Server] Running at http://localhost:3000
==============================================
  Scan this QR code to link your WhatsApp:
  Phone > WhatsApp > Linked Devices > Link a Device
==============================================
[Qrcode shown in terminal]
```

### 4. Authenticate with the QR code
1. Open WhatsApp on your phone.
2. Go to **Settings > Linked Devices > Link a Device**.
3. Point the phone camera at the QR code printed in the terminal.
4. Wait for `[WhatsApp] Client is ready!` in the terminal.
   - The session is saved to the `.wwebjs_auth` folder, so you only scan **once**.
     Next time you run `npm start` it connects automatically.

### 5. Test the bulk sender
1. Open your browser at **http://localhost:3000**.
2. The green pill should read **"WhatsApp connected"**.
3. In **WhatsApp Numbers**, enter numbers with country codes, separated by commas:
   ```
   +919876543210, +14155552671, +491512345678
   ```
4. Type your message.
5. Click **Send to All**. The page does **not** refresh.
6. Below the form you will see a summary (Total / Sent / Failed) and one row per
   number showing **Sent** or **Failed** (with the reason, e.g. "not registered on WhatsApp").

## How it works (for your report)

- `index.html` sends an async `POST /send-bulk-message` using the `fetch()` API.
  `e.preventDefault()` stops the page from reloading.
- `server.js` receives `{ numbers: [...], message: "..." }`, then loops through the
  numbers one by one.
- A **randomized 1–3 second delay** is inserted between each send so WhatsApp does not
  flag the session as spam, even though the whole batch is a single request.
- Before sending, each number is checked with `client.getNumberId()` to see if it is a
  real WhatsApp account.
- The server replies with:
  ```json
  { "success": true, "total": 3, "sent": 2, "failed": 1,
    "results": [
      { "number": "+919876543210", "status": "sent" },
      { "number": "+14155552671", "status": "failed", "error": "..." }
    ] }
  ```
- The frontend renders this response dynamically as green/red badges.

## Troubleshooting

- **"Scan QR code in terminal"** pill shows in the browser: WhatsApp is not linked yet;
  check the terminal and scan the QR.
- **Blank QR / QR expired**: restart with `npm start` (old QR codes expire quickly).
- **Port 3000 already in use**: run `PORT=3001 npm start` (Windows CMD: `set PORT=3001` then `npm start`).
- **Slow first send**: the first message after startup can take longer while WhatsApp Web
  finishes loading contacts.
- **Chromium fails to download**: run `npm install` again, or manually install
  Chrome/Chromium and add `"puppeteer": { "executablePath": "C:/Path/To/chrome.exe" }`
  inside the `Client` options in `server.js`.

## Important warning

Automated or unsolicited bulk messaging can get your WhatsApp number **temporarily banned**
if abused. Use this project only with numbers that have given consent (demo, friends,
classmates, your own second number), keep batch sizes small, and always keep the delay.
