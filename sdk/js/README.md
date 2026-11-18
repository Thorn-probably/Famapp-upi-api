# famapp-verify-client

Zero-dependency, lightweight JavaScript/TypeScript client helper for FamApp UPI payment verification via Cloudflare Worker.

## Installation

```bash
npm install famapp-verify-client
```

Or copy `index.js` directly into your project.

## Usage

```javascript
import { FamAppClient } from "famapp-verify-client";

const famapp = new FamAppClient({
  workerUrl: "https://your-worker.workers.dev",
  apiKey: "optional-secret-key" // if worker is protected by API_KEY
});

// Trigger verification with built-in retry polling
const result = await famapp.verify({
  utr: "319105912273",
  expectedAmount: 100.0,
  orderId: "ORD-123",
  retries: 3,         // Retry up to 3 times if email hasn't landed in Gmail yet
  retryDelayMs: 3000, // Wait 3s between retries
  markAsRead: true,   // Mark email as read in Gmail upon successful claim
  onPoll: (attempt, total) => {
    console.log(`Polling payment status... (Attempt ${attempt}/${total})`);
  }
});

if (result.success) {
  console.log("Verified payment:", result.amount, "from:", result.sender);
  console.log("FamApp Txn ID:", result.txnId);
} else {
  console.error("Verification failed:", result.status, result.message);
}
```
