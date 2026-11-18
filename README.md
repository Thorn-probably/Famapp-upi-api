# FamApp Serverless UPI Payment Verification Engine

A lightweight, serverless UPI verification engine that validates FamApp / FamPay transaction emails directly via the Gmail API on-demand, prevents replay attacks using Cloudflare KV, fires HMAC-signed outgoing webhooks, and provides drop-in Client SDKs for JavaScript and Python.

---

## ⚡ Architecture & Flow

```
[ User / Frontend / Backend ]
          │
          │ 1. POST /verify { utr, expected_amount, order_id }
          ▼
┌────────────────────────────────────────────────────────┐
│             Cloudflare Worker (Serverless)             │
│                                                        │
│  1. Check PAYMENTS_KV for "claimed_{utr}"              │
│     └── If found ──> Return 409 ALREADY_CLAIMED        │
│                                                        │
│  2. Fetch fresh OAuth token from Google on-demand      │
│     └── POST https://oauth2.googleapis.com/token       │
│                                                        │
│  3. Search Gmail:                                      │
│     from:no-reply@famapp.in "{utr}" is:unread          │
│     (Fallback: search without is:unread, < 60 min)     │
│                                                        │
│  4. Decode email body & match FamApp regex             │
│     └── Verify amount_received >= expected_amount      │
│                                                        │
│  5. Put "claimed_{utr}" into PAYMENTS_KV               │
│                                                        │
│  6. Mark email as READ (remove UNREAD label)           │
│                                                        │
│  7. Dispatch Outgoing Webhook (HMAC-SHA256 signed)     │
└────────────────────────────────────────────────────────┘
          │
          │ 200 OK { success: true, status: "VERIFIED", ... }
          ▼
[ Verified Payment Response ]
```

---

## 🔑 Step 1: 3-Minute Google OAuth Refresh Token Guide

To allow the Cloudflare Worker to read FamApp confirmation emails from your Gmail inbox, you need 3 credentials:
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`

### A. Create Google Cloud OAuth Credentials
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (e.g. `FamApp-Verification`).
3. Navigate to **APIs & Services > Library**, search for **Gmail API**, and click **Enable**.
4. Go to **APIs & Services > OAuth consent screen**:
   - Choose **External**, then click **Create**.
   - Fill in an App name (e.g. `UPI Verifier`) and user support email.
   - Under **Test Users**, add your personal Gmail address (the one receiving FamApp emails).
5. Go to **APIs & Services > Credentials**:
   - Click **Create Credentials > OAuth client ID**.
   - Select Application type: **Web application**.
   - Under **Authorized redirect URIs**, add:
     `https://developers.google.com/oauthplayground`
   - Click **Create**. Copy your **Client ID** and **Client Secret**.

### B. Generate Permanent Refresh Token (OAuth Playground)
1. Open the [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground).
2. Click the gear icon (⚙️) in the top-right corner:
   - Check **Use your own OAuth credentials**.
   - Paste your **OAuth Client ID** and **OAuth Client Secret**.
3. In the left panel (Step 1 - Select & authorize APIs):
   - Scroll down or input: `https://www.googleapis.com/auth/gmail.modify`
   - Click **Authorize APIs**.
   - Sign in with the Google account receiving FamApp emails and allow permissions.
4. In Step 2 (Exchange authorization code for tokens):
   - Click **Exchange authorization code for tokens**.
   - Copy the value of **Refresh token** (this is your permanent `GMAIL_REFRESH_TOKEN`).

---

## 🚀 Step 2: Deploy Cloudflare Worker

### 1. Install & Authenticate Wrangler
```bash
cd worker
npm install
npx wrangler login
```

### 2. Create the Cloudflare KV Namespace
Run the following command to create your production KV namespace:
```bash
npx wrangler kv namespace create PAYMENTS_KV
```
You will see output like:
```toml
[[kv_namespaces]]
binding = "PAYMENTS_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```
Copy that `id` into `worker/wrangler.toml`.

*(Optional: create preview namespace for local development with `npx wrangler kv namespace create PAYMENTS_KV --preview`)*.

### 3. Set Worker Secrets
Run each command to securely store your credentials in Cloudflare:
```bash
npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN

# Optional: Protect Worker with an API key
npx wrangler secret put API_KEY

# Optional: Outgoing webhook URL & secret
npx wrangler secret put OUTGOING_WEBHOOK_URL
npx wrangler secret put WEBHOOK_SECRET
```

### 4. Deploy to Cloudflare
```bash
npx wrangler deploy
```
Your Worker URL will look like `https://famapp-upi-verification.<your-subdomain>.workers.dev`.

---

## 💻 Step 3: Frontend Client SDK (JavaScript / TypeScript)

Zero external dependencies. Works out of the box in React, Vue, Next.js, or vanilla JS.

```bash
cd sdk/js
npm install
```

### Quick Example
```javascript
import { FamAppClient } from "famapp-verify-client";

const famapp = new FamAppClient({
  workerUrl: "https://famapp-upi-verification.<your-subdomain>.workers.dev",
  apiKey: "YOUR_OPTIONAL_API_KEY" // optional
});

// Trigger verification with built-in retry polling
const result = await famapp.verify({
  utr: "319105912273",
  expectedAmount: 100.0,
  orderId: "ORD-123",
  retries: 3,         // Auto-retries up to 3 times if email hasn't arrived
  retryDelayMs: 3000, // Waits 3s between retries
  markAsRead: true,   // Mark email as read in Gmail
  onPoll: (attempt, max) => {
    console.log(`Checking payment status... (Attempt ${attempt}/${max})`);
  }
});

if (result.success) {
  console.log("Verified ₹" + result.amount + " from " + result.sender);
  console.log("FamApp Transaction ID:", result.txnId);
} else {
  console.error("Payment status:", result.status, result.message);
}
```

---

## 🐍 Step 4: Python Client SDK (`fampay_worker`)

Works with `httpx`, `requests`, or Python's built-in `urllib`.

### Installation
```bash
cd sdk/python
pip install -e .
```

### Synchronous Usage
```python
from fampay_worker import FamPayGateway

gateway = FamPayGateway(
    worker_url="https://famapp-upi-verification.<your-subdomain>.workers.dev",
    api_key="YOUR_OPTIONAL_API_KEY"
)

verification = gateway.verify(
    utr="319105912273",
    expected_amount=100.0,
    order_id="ORD-123",
    auto_retry=True,
    retries=3,
    retry_delay=3.0
)

if verification.is_verified:
    print(f"Payment received: ₹{verification.amount} from {verification.sender}")
    print(f"Txn ID: {verification.txn_id}")
elif verification.is_already_claimed:
    print("Warning: This UTR was already claimed!")
else:
    print(f"Verification failed: {verification.status} - {verification.message}")
```

### Asynchronous Usage (FastAPI / Asyncio)
```python
import asyncio
from fampay_worker import AsyncFamPayGateway

async def check_payment():
    gateway = AsyncFamPayGateway(worker_url="https://famapp-upi-verification.<your-subdomain>.workers.dev")
    
    result = await gateway.verify(
        utr="319105912273",
        expected_amount=100.0,
        order_id="ORD-123",
        auto_retry=True
    )
    
    if result.is_verified:
        print(f"Verified ₹{result.amount} from {result.sender}")
    return result

# asyncio.run(check_payment())
```

---

## 🛡️ Outgoing Webhooks & Signature Verification

When `OUTGOING_WEBHOOK_URL` is set, the Worker dispatches an HTTP POST when a transaction is verified:

```json
{
  "event": "PAYMENT_SUCCESS",
  "utr": "319105912273",
  "amount": 100.0,
  "sender": "Jane Doe",
  "order_id": "ORD-123",
  "txn_id": "FMPIB123456789",
  "time": "08:30 PM",
  "date": "16 November 2026",
  "claimed_at": 1794844800000
}
```

If `WEBHOOK_SECRET` is set, the Worker includes a header:
```http
X-Signature-SHA256: <hex_hmac_sha256_of_raw_body>
```

### Verifying Webhook in Node.js
```javascript
import crypto from "crypto";

function verifyWebhook(rawBody, signatureHeader, secret) {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(rawBody);
  const expected = hmac.digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
}
```

### Verifying Webhook in Python
```python
import hmac
import hashlib

def verify_webhook(raw_body_bytes: bytes, signature_header: str, secret: str) -> bool:
    expected = hmac.new(secret.encode("utf-8"), raw_body_bytes, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature_header, expected)
```

---

## 📁 Repository Structure

```
├── worker/
│   ├── wrangler.toml         # Cloudflare Worker configuration & KV binding
│   ├── package.json          # Worker package manifest
│   └── src/
│       └── index.js          # Core verification engine, Gmail API, KV & Webhooks
├── sdk/
│   ├── js/
│   │   ├── package.json      # npm package manifest (famapp-verify-client)
│   │   ├── index.js          # Zero-dependency JS Client SDK
│   │   ├── index.d.ts        # TypeScript typings
│   │   └── README.md
│   └── python/
│       ├── pyproject.toml    # Python package configuration (fampay-worker)
│       ├── fampay_worker/
│       │   ├── __init__.py   # Exports FamPayGateway, AsyncFamPayGateway, etc.
│       │   ├── client.py     # Sync & Async client implementations
│       │   └── models.py     # VerificationResult dataclass
│       └── README.md
└── README.md                 # Complete setup, OAuth guide, and deployment manual
```
