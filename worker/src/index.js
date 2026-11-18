/**
 * FamApp UPI Payment Verification Cloudflare Worker (Hardened Edition)
 * 
 * Verifies UPI payments made via FamApp/FamPay on-demand by checking Gmail notification emails,
 * guards against replay attacks using Cloudflare KV, and dispatches outgoing webhooks.
 * 
 * Security Controls:
 * - Fail-Secure Constant-Time Authentication (Anti-Timing Attack)
 * - Distributed Rate Limiting via KV
 * - Strict Input Validation & Length Limits
 * - Information Leakage Prevention (No PII / Internal Data in Errors)
 * - Hardened Security Headers (HSTS, CSP, X-Frame-Options, Cache-Control)
 */

// FamApp notification regex (Classic format)
const FAMAPP_REGEX = /received ₹(?<amount>[\d,]+(?:\.\d+)?)\s+from (?<sender>.+?)\s+at (?<time>\d{1,2}:\d{2}\s*(?:AM|PM))\s+IST,\s+(?<date>\d{1,2}\s+[A-Za-z]+\s+\d{4})\s+with transaction id (?<txn_id>FMPIB\d+)\.\s*Your updated balance is ₹(?<balance>[\d,]+(?:\.\d+)?)\.(?:\s*UTR:\s*(?<utr>\d{12})\.)?/i;

// Fallback search window for read emails (default 24 hours)
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Rate limit settings (per IP)
const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_MAX_REQUESTS = 15;

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = getCorsHeaders(request, env);

    // Handle preflight OPTIONS request
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          ...getSecurityHeaders()
        },
      });
    }

    const url = new URL(request.url);

    // Health check endpoint (Minimal exposure - no internal details)
    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({ status: "healthy" }, 200, corsHeaders);
    }

    // Verify endpoint
    if (url.pathname === "/verify" && request.method === "POST") {
      return handleVerify(request, env, ctx, corsHeaders);
    }

    return jsonResponse({
      success: false,
      status: "NOT_FOUND",
      message: "Resource not found."
    }, 404, corsHeaders);
  }
};

/**
 * Handle POST /verify
 */
async function handleVerify(request, env, ctx, corsHeaders) {
  // 1. Mandatory Fail-Secure Authentication
  if (!env.API_KEY || env.API_KEY.trim() === "") {
    return jsonResponse({
      success: false,
      status: "CONFIG_ERROR",
      message: "Server authentication is unconfigured. Contact administrator."
    }, 503, corsHeaders);
  }

  const authHeader = request.headers.get("authorization") || "";
  const apiKeyHeader = request.headers.get("x-api-key") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : apiKeyHeader;

  if (!token || !timingSafeEqual(token, env.API_KEY)) {
    return jsonResponse({
      success: false,
      status: "UNAUTHORIZED",
      message: "Invalid or missing authentication credentials."
    }, 401, corsHeaders);
  }

  // 2. IP-Based Distributed Rate Limiting (Prevent DoS & Google Quota Exhaustion)
  if (env.PAYMENTS_KV) {
    const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
    const rlKey = `rl_${clientIp}`;
    const currentCount = (await env.PAYMENTS_KV.get(rlKey)) || 0;
    const reqCount = parseInt(currentCount, 10);

    if (reqCount >= RATE_LIMIT_MAX_REQUESTS) {
      return jsonResponse({
        success: false,
        status: "RATE_LIMITED",
        message: "Too many verification requests. Please retry in 60 seconds."
      }, 429, corsHeaders);
    }

    // Increment request count with expiration
    ctx.waitUntil(env.PAYMENTS_KV.put(rlKey, String(reqCount + 1), { expirationTtl: RATE_LIMIT_WINDOW_SEC }));
  }

  // 3. Payload Size Guard (Max 8KB)
  const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > 8192) {
    return jsonResponse({
      success: false,
      status: "PAYLOAD_TOO_LARGE",
      message: "Request payload exceeds 8KB limit."
    }, 413, corsHeaders);
  }

  // 4. Parse Request Body
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({
      success: false,
      status: "BAD_REQUEST",
      message: "Invalid JSON request body."
    }, 400, corsHeaders);
  }

  const utr = String(body.utr || "").trim();
  const rawExpectedAmount = body.expected_amount ?? body.expectedAmount;
  const rawOrderId = body.order_id ?? body.orderId ?? null;
  const markAsRead = body.mark_as_read ?? body.markAsRead ?? true;

  // Strict UTR Validation: Exactly 12 digits (prevents search query injection)
  if (!utr || !/^\d{12}$/.test(utr)) {
    return jsonResponse({
      success: false,
      status: "INVALID_UTR",
      message: "Invalid UTR format. Expected a 12-digit numeric string."
    }, 400, corsHeaders);
  }

  // Strict Amount Validation
  const expectedAmount = parseFloat(rawExpectedAmount);
  if (isNaN(expectedAmount) || expectedAmount <= 0 || expectedAmount > 1000000) {
    return jsonResponse({
      success: false,
      status: "INVALID_AMOUNT",
      message: "Invalid expected_amount. Must be a positive number up to 1,000,000."
    }, 400, corsHeaders);
  }

  // Sanitize & Bound Order ID
  let orderId = null;
  if (rawOrderId != null) {
    const strOrderId = String(rawOrderId).trim();
    if (strOrderId.length > 64 || !/^[A-Za-z0-9_\-.:#]{1,64}$/.test(strOrderId)) {
      return jsonResponse({
        success: false,
        status: "INVALID_ORDER_ID",
        message: "Invalid order_id. Must be alphanumeric and up to 64 characters."
      }, 400, corsHeaders);
    }
    orderId = strOrderId;
  }

  // 5. Anti-Replay: Check Cloudflare KV for existing claim
  if (!env.PAYMENTS_KV) {
    return jsonResponse({
      success: false,
      status: "CONFIG_ERROR",
      message: "Database binding error."
    }, 500, corsHeaders);
  }

  const existingClaim = await env.PAYMENTS_KV.get(`claimed_${utr}`, "json");
  if (existingClaim) {
    // Information Disclosure Prevention: Do not leak previous claimant's order_id or amount
    return jsonResponse({
      success: false,
      status: "ALREADY_CLAIMED",
      message: "This UTR has already been claimed and processed."
    }, 409, corsHeaders);
  }

  // 6. Validate Google OAuth Configuration
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    return jsonResponse({
      success: false,
      status: "CONFIG_ERROR",
      message: "Email provider credentials unconfigured."
    }, 500, corsHeaders);
  }

  // 7. Fetch Fresh Google OAuth Access Token on-demand
  let accessToken;
  try {
    accessToken = await getFreshAccessToken(env);
  } catch (err) {
    return jsonResponse({
      success: false,
      status: "AUTH_ERROR",
      message: "Failed to connect to email provider service."
    }, 502, corsHeaders);
  }

  // 8. Search Gmail for FamApp notification email
  let messageId = null;
  let isFallback = false;

  const queries = [
    `from:(famapp.in OR fampay.in) ${utr} is:unread`,
    `from:(famapp.in OR fampay.in) ${utr}`,
    `${utr}`
  ];

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const msgs = await searchGmailMessages(accessToken, q);
    if (msgs && msgs.length > 0) {
      messageId = msgs[0].id;
      if (i > 0) isFallback = true;
      break;
    }
  }

  // If no message found matching UTR
  if (!messageId) {
    return jsonResponse({
      success: false,
      status: "PENDING",
      message: "Transaction not found in Gmail. Please wait 5 seconds and retry."
    }, 404, corsHeaders);
  }

  // 9. Fetch Full Email Message Details
  const messageDetail = await getGmailMessage(accessToken, messageId);
  if (!messageDetail) {
    return jsonResponse({
      success: false,
      status: "PENDING",
      message: "Unable to retrieve email message content."
    }, 404, corsHeaders);
  }

  // Step 9b: Validate timestamp if matched via fallback
  const internalDate = parseInt(messageDetail.internalDate, 10);
  const maxAgeHours = parseFloat(env.MAX_AGE_HOURS || "24");
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

  if (isFallback && !isNaN(internalDate)) {
    const ageMs = Date.now() - internalDate;
    if (ageMs > maxAgeMs) {
      return jsonResponse({
        success: false,
        status: "EXPIRED",
        message: "Transaction email has expired beyond the verification window."
      }, 410, corsHeaders);
    }
  }

  // 10. Extract & Decode Email Content
  const emailContent = extractEmailText(messageDetail);

  // 11. Match FamApp Details (Supports both classic and modern formats)
  const parsed = parseFamAppEmail(emailContent);
  if (!parsed || isNaN(parsed.amount)) {
    return jsonResponse({
      success: false,
      status: "PARSE_ERROR",
      message: "Email received but transaction format could not be verified."
    }, 422, corsHeaders);
  }

  const parsedAmount = parsed.amount;
  const sender = parsed.sender || "Unknown";
  const txnId = parsed.txn_id || "";
  const time = parsed.time || "";
  const date = parsed.date || "";
  const balance = parsed.balance || null;

  // 12. Verify Received Amount >= Expected Amount
  if (parsedAmount < expectedAmount) {
    return jsonResponse({
      success: false,
      status: "AMOUNT_MISMATCH",
      message: "Amount received is less than expected."
    }, 400, corsHeaders);
  }

  // 13. Record into Cloudflare KV (Anti-Replay)
  const claimRecord = {
    utr,
    amount: parsedAmount,
    sender,
    order_id: orderId,
    txn_id: txnId,
    time,
    date,
    balance,
    email_id: messageId,
    claimed_at: Date.now()
  };

  await env.PAYMENTS_KV.put(`claimed_${utr}`, JSON.stringify(claimRecord));

  // 14. Mark Email as Read
  if (markAsRead) {
    ctx.waitUntil(markGmailAsRead(accessToken, messageId));
  }

  // 15. Dispatch Outgoing Webhook
  const webhookUrl = env.OUTGOING_WEBHOOK_URL;
  if (webhookUrl) {
    const webhookPayload = {
      event: "PAYMENT_SUCCESS",
      utr,
      amount: parsedAmount,
      sender,
      order_id: orderId,
      txn_id: txnId,
      time,
      date,
      claimed_at: claimRecord.claimed_at
    };

    ctx.waitUntil(dispatchWebhook(webhookUrl, webhookPayload, env.WEBHOOK_SECRET));
  }

  // 16. Return Success Response
  return jsonResponse({
    success: true,
    status: "VERIFIED",
    amount: parsedAmount,
    sender,
    utr,
    txn_id: txnId,
    order_id: orderId
  }, 200, corsHeaders);
}

/**
 * Constant-time string equality to prevent timing attacks
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;

  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

/**
 * Fetch a fresh Google OAuth2 access token on-demand
 */
async function getFreshAccessToken(env) {
  const tokenUrl = "https://oauth2.googleapis.com/token";
  const params = new URLSearchParams({
    client_id: env.GMAIL_CLIENT_ID,
    client_secret: env.GMAIL_CLIENT_SECRET,
    refresh_token: env.GMAIL_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `HTTP ${response.status}`);
  }

  return data.access_token;
}

/**
 * Search Gmail messages
 */
async function searchGmailMessages(accessToken, query) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=5`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  return data.messages || [];
}

/**
 * Get full Gmail message by ID
 */
async function getGmailMessage(accessToken, messageId) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    return null;
  }

  return await response.json();
}

/**
 * Mark a Gmail message as read
 */
async function markGmailAsRead(accessToken, messageId) {
  try {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`;
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        removeLabelIds: ["UNREAD"]
      })
    });
  } catch (err) {
    console.error("Failed to mark email as read:", err);
  }
}

/**
 * Dispatch outgoing webhook with optional HMAC SHA-256 signature
 */
async function dispatchWebhook(url, payload, secret) {
  try {
    const payloadString = JSON.stringify(payload);
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "FamApp-UPI-Verification-Worker/1.0"
    };

    if (secret) {
      const signature = await computeHmacSha256(secret, payloadString);
      headers["X-Signature-SHA256"] = signature;
    }

    // Abort after 5 seconds to prevent hanging worker isolates
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    await fetch(url, {
      method: "POST",
      headers,
      body: payloadString,
      signal: controller.signal
    });

    clearTimeout(timeout);
  } catch (err) {
    console.error("Webhook dispatch failed:", err);
  }
}

/**
 * Compute HMAC-SHA256 signature using standard Web Crypto API
 */
async function computeHmacSha256(secret, message) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(message);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Decode Base64URL string
 */
function decodeBase64Url(input) {
  if (!input) return "";
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  try {
    return atob(base64);
  } catch (e) {
    return "";
  }
}

/**
 * Extract plain text from Gmail payload
 */
function extractEmailText(message) {
  let text = "";

  if (message.snippet) {
    text += message.snippet + "\n";
  }

  function walkParts(payload) {
    if (!payload) return;

    if (payload.body && payload.body.data) {
      const decoded = decodeBase64Url(payload.body.data);
      const cleaned = decoded
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&#160;/gi, " ");
      text += cleaned + "\n";
    }

    if (payload.parts && Array.isArray(payload.parts)) {
      for (const part of payload.parts) {
        walkParts(part);
      }
    }
  }

  walkParts(message.payload);
  return text.replace(/\u00A0/g, " ").replace(/[ \t]+/g, " ");
}

/**
 * Parse FamApp transaction email text
 */
function parseFamAppEmail(content) {
  const fullMatch = FAMAPP_REGEX.exec(content);
  if (fullMatch && fullMatch.groups) {
    return {
      amount: parseFloat(fullMatch.groups.amount.replace(/,/g, "")),
      sender: fullMatch.groups.sender ? fullMatch.groups.sender.trim() : "Unknown",
      txn_id: fullMatch.groups.txn_id || "",
      time: fullMatch.groups.time || "",
      date: fullMatch.groups.date || "",
      balance: fullMatch.groups.balance ? parseFloat(fullMatch.groups.balance.replace(/,/g, "")) : null
    };
  }

  const amountMatch = content.match(/(?:received|credited)\s+₹\s*(?<amount>[\d,]+(?:\.\d+)?)/i);
  if (!amountMatch) return null;

  const amount = parseFloat(amountMatch.groups.amount.replace(/,/g, ""));

  const senderMatch = content.match(/(?:from)\s+([A-Za-z0-9\s.]+?)(?:Transaction\s*ID|\s+with\s+transaction|at\s+\d|\.|$)/i);
  const sender = senderMatch ? senderMatch[1].trim() : "Unknown";

  const txnMatch = content.match(/(?:Transaction\s*ID\s*:\s*|transaction\s+id\s+)(?<txn_id>FMPIB[A-Za-z0-9]+)/i);
  const txn_id = txnMatch ? txnMatch.groups.txn_id : "";

  const timeMatch = content.match(/(?<time>\d{1,2}:\d{2}\s*(?:AM|PM))\s*IST/i);
  const time = timeMatch ? timeMatch.groups.time + " IST" : "";

  const dateMatch = content.match(/(?<date>\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
  const date = dateMatch ? dateMatch.groups.date : "";

  const balanceMatch = content.match(/(?:updated\s+balance\s+is\s+₹|balance:\s*₹)(?<balance>[\d,]+(?:\.\d+)?)/i);
  const balance = balanceMatch ? parseFloat(balanceMatch.groups.balance.replace(/,/g, "")) : null;

  return { amount, sender, txn_id, time, date, balance };
}

/**
 * Compute CORS headers
 */
function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN || "";

  let allowOrigin = "";
  if (allowed === "*") {
    allowOrigin = "*";
  } else if (allowed && origin) {
    const list = allowed.split(",").map(o => o.trim());
    if (list.includes(origin)) {
      allowOrigin = origin;
    }
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin || "null",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    "Access-Control-Max-Age": "86400"
  };
}

/**
 * Modern Security Headers
 */
function getSecurityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Referrer-Policy": "no-referrer"
  };
}

/**
 * Helper to return JSON Response with Security Headers
 */
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...getSecurityHeaders(),
      ...extraHeaders
    }
  });
}
