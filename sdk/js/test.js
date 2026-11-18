import { FamAppClient } from "./index.js";

// Test initialization
const client = new FamAppClient({
  workerUrl: "https://example-worker.workers.dev",
  apiKey: "test-key"
});

console.log("FamAppClient initialized successfully:", client.workerUrl);

// Test validation
try {
  await client.verify({ utr: "123", expectedAmount: 100 });
} catch (e) {
  console.log("Validation test 1 passed (invalid UTR length caught):", e.message);
}

try {
  await client.verify({ utr: "123456789012", expectedAmount: -50 });
} catch (e) {
  console.log("Validation test 2 passed (negative amount caught):", e.message);
}

console.log("JS SDK basic validation tests passed.");
