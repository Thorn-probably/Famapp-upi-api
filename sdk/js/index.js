/**
 * FamApp UPI Verification Client SDK (Browser & Node.js 18+)
 * Zero dependencies, built with standard Fetch API.
 */

export class FamAppClient {
  /**
   * @param {Object} options
   * @param {string} options.workerUrl - Cloudflare Worker base URL (e.g. "https://your-worker.workers.dev")
   * @param {string} [options.apiKey] - Optional API key for authenticating to the worker
   * @param {number} [options.defaultRetries=3] - Number of retry attempts when status is PENDING
   * @param {number} [options.defaultRetryDelayMs=3000] - Delay between retries in milliseconds
   */
  constructor(options = {}) {
    if (!options.workerUrl) {
      throw new Error("FamAppClient requires 'workerUrl' in configuration options.");
    }

    this.workerUrl = options.workerUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey || null;
    this.defaultRetries = options.defaultRetries ?? 3;
    this.defaultRetryDelayMs = options.defaultRetryDelayMs ?? 3000;
  }

  /**
   * Verify a UPI transaction by UTR with automatic polling/retry support.
   *
   * @param {Object} params
   * @param {string} params.utr - 12-digit UPI UTR number
   * @param {number} params.expectedAmount - Expected payment amount in INR
   * @param {string} [params.orderId] - Optional merchant order ID
   * @param {number} [params.retries] - Custom retry count (defaults to client setting)
   * @param {number} [params.retryDelayMs] - Custom retry interval in ms (defaults to client setting)
   * @param {boolean} [params.markAsRead=true] - Whether to mark the FamApp notification email as read
   * @param {Function} [params.onPoll] - Optional callback triggered on each retry attempt: (attempt, totalRetries) => void
   * @returns {Promise<VerificationResponse>}
   */
  async verify(params) {
    const {
      utr,
      expectedAmount,
      orderId = null,
      retries = this.defaultRetries,
      retryDelayMs = this.defaultRetryDelayMs,
      markAsRead = true,
      onPoll = null
    } = params || {};

    if (!utr || typeof utr !== "string" || !/^\d{12}$/.test(utr.trim())) {
      throw new Error("Invalid UTR: must be a 12-digit numeric string.");
    }

    if (expectedAmount == null || isNaN(expectedAmount) || Number(expectedAmount) <= 0) {
      throw new Error("Invalid expectedAmount: must be a positive number.");
    }

    const payload = {
      utr: utr.trim(),
      expected_amount: Number(expectedAmount),
      order_id: orderId,
      mark_as_read: Boolean(markAsRead)
    };

    let attempt = 0;
    while (true) {
      attempt++;
      try {
        const result = await this._makeRequest(payload);

        // If verified, return immediately
        if (result.success && result.status === "VERIFIED") {
          return {
            success: true,
            status: "VERIFIED",
            amount: result.amount,
            sender: result.sender,
            utr: result.utr,
            txnId: result.txn_id,
            orderId: result.order_id,
            raw: result
          };
        }

        // If duplicate / already claimed
        if (result.status === "ALREADY_CLAIMED") {
          return {
            success: false,
            status: "ALREADY_CLAIMED",
            message: result.message || "UTR has already been claimed.",
            raw: result
          };
        }

        // If amount mismatch or expired
        if (["AMOUNT_MISMATCH", "EXPIRED", "UNAUTHORIZED", "INVALID_UTR"].includes(result.status)) {
          return {
            success: false,
            status: result.status,
            message: result.message || "Verification failed.",
            raw: result
          };
        }

        // If PENDING and we still have retries
        if (result.status === "PENDING" && attempt <= retries) {
          if (typeof onPoll === "function") {
            onPoll(attempt, retries);
          }
          await this._sleep(retryDelayMs);
          continue;
        }

        // Retries exhausted
        return {
          success: false,
          status: result.status || "PENDING",
          message: result.message || "Transaction not found after retry attempts.",
          attempts: attempt,
          raw: result
        };
      } catch (err) {
        if (attempt <= retries) {
          if (typeof onPoll === "function") {
            onPoll(attempt, retries);
          }
          await this._sleep(retryDelayMs);
          continue;
        }
        return {
          success: false,
          status: "NETWORK_ERROR",
          message: err.message || "Failed to communicate with verification worker.",
          attempts: attempt
        };
      }
    }
  }

  /**
   * Internal HTTP request execution
   * @private
   */
  async _makeRequest(payload) {
    const headers = {
      "Content-Type": "application/json"
    };

    if (this.apiKey) {
      headers["X-API-Key"] = this.apiKey;
    }

    const response = await fetch(`${this.workerUrl}/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    return data;
  }

  /**
   * Internal sleep helper
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default FamAppClient;
