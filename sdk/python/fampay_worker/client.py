import time
import json
import asyncio
from typing import Optional, Dict, Any, Callable

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

from urllib import request as urllib_request
from urllib.error import HTTPError, URLError

from .models import VerificationResult


class FamPayGateway:
    """
    Synchronous client for verifying FamApp UPI payments via Cloudflare Worker.
    Works seamlessly with httpx, requests, or Python's built-in urllib.
    """

    def __init__(
        self,
        worker_url: str,
        api_key: Optional[str] = None,
        default_retries: int = 3,
        default_retry_delay: float = 3.0,
        timeout: float = 20.0
    ):
        self.worker_url = worker_url.rstrip("/")
        self.api_key = api_key
        self.default_retries = default_retries
        self.default_retry_delay = default_retry_delay
        self.timeout = timeout

    def _headers(self) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "FamPayGateway-Python/1.0"
        }
        if self.api_key:
            headers["X-API-Key"] = self.api_key
        return headers

    def _http_post(self, url: str, payload: dict) -> tuple[int, dict]:
        """Performs HTTP POST using available HTTP client (httpx -> requests -> urllib)."""
        headers = self._headers()

        if HAS_HTTPX:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.post(url, headers=headers, json=payload)
                return resp.status_code, resp.json()

        if HAS_REQUESTS:
            resp = requests.post(url, headers=headers, json=payload, timeout=self.timeout)
            return resp.status_code, resp.json()

        # Fallback to standard library urllib
        data_bytes = json.dumps(payload).encode("utf-8")
        req = urllib_request.Request(url, data=data_bytes, headers=headers, method="POST")
        try:
            with urllib_request.urlopen(req, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
                return response.status, json.loads(body)
        except HTTPError as e:
            body = e.read().decode("utf-8")
            try:
                data = json.loads(body)
            except Exception:
                data = {"message": str(e)}
            return e.code, data

    def verify(
        self,
        utr: str,
        expected_amount: float,
        order_id: Optional[str] = None,
        auto_retry: bool = True,
        retries: Optional[int] = None,
        retry_delay: Optional[float] = None,
        mark_as_read: bool = True,
        on_poll: Optional[Callable[[int, int], None]] = None
    ) -> VerificationResult:
        clean_utr = str(utr).strip()
        if not clean_utr.isdigit() or len(clean_utr) != 12:
            raise ValueError(f"Invalid UTR '{utr}': must be a 12-digit numeric string.")

        if expected_amount <= 0:
            raise ValueError(f"Invalid expected_amount '{expected_amount}': must be positive.")

        max_retries = (retries if retries is not None else self.default_retries) if auto_retry else 0
        delay = retry_delay if retry_delay is not None else self.default_retry_delay

        payload = {
            "utr": clean_utr,
            "expected_amount": float(expected_amount),
            "order_id": order_id,
            "mark_as_read": mark_as_read
        }

        attempt = 0
        while True:
            attempt += 1
            try:
                status_code, data = self._http_post(f"{self.worker_url}/verify", payload)

                if status_code == 200 and data.get("success"):
                    return VerificationResult(
                        success=True,
                        status="VERIFIED",
                        amount=data.get("amount"),
                        sender=data.get("sender"),
                        utr=data.get("utr"),
                        txn_id=data.get("txn_id"),
                        order_id=data.get("order_id"),
                        attempts=attempt,
                        raw=data
                    )

                status = data.get("status", "UNKNOWN")
                if status == "PENDING" and attempt <= max_retries:
                    if on_poll:
                        on_poll(attempt, max_retries)
                    time.sleep(delay)
                    continue

                return VerificationResult(
                    success=False,
                    status=status,
                    amount=data.get("amount_received"),
                    sender=data.get("sender"),
                    utr=data.get("utr") or clean_utr,
                    txn_id=data.get("txn_id"),
                    order_id=data.get("order_id") or order_id,
                    message=data.get("message"),
                    attempts=attempt,
                    raw=data
                )

            except Exception as exc:
                if attempt <= max_retries:
                    if on_poll:
                        on_poll(attempt, max_retries)
                    time.sleep(delay)
                    continue
                return VerificationResult(
                    success=False,
                    status="NETWORK_ERROR",
                    message=f"Request error: {str(exc)}",
                    attempts=attempt
                )


class AsyncFamPayGateway:
    """
    Asynchronous client for verifying FamApp UPI payments via Cloudflare Worker.
    Uses httpx.AsyncClient.
    """

    def __init__(
        self,
        worker_url: str,
        api_key: Optional[str] = None,
        default_retries: int = 3,
        default_retry_delay: float = 3.0,
        timeout: float = 20.0
    ):
        if not HAS_HTTPX:
            raise ImportError(
                "httpx is required for AsyncFamPayGateway. Please install it via 'pip install httpx'."
            )
        self.worker_url = worker_url.rstrip("/")
        self.api_key = api_key
        self.default_retries = default_retries
        self.default_retry_delay = default_retry_delay
        self.timeout = timeout

    def _headers(self) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "AsyncFamPayGateway-Python/1.0"
        }
        if self.api_key:
            headers["X-API-Key"] = self.api_key
        return headers

    async def verify(
        self,
        utr: str,
        expected_amount: float,
        order_id: Optional[str] = None,
        auto_retry: bool = True,
        retries: Optional[int] = None,
        retry_delay: Optional[float] = None,
        mark_as_read: bool = True,
        on_poll: Optional[Callable[[int, int], None]] = None
    ) -> VerificationResult:
        clean_utr = str(utr).strip()
        if not clean_utr.isdigit() or len(clean_utr) != 12:
            raise ValueError(f"Invalid UTR '{utr}': must be a 12-digit numeric string.")

        if expected_amount <= 0:
            raise ValueError(f"Invalid expected_amount '{expected_amount}': must be positive.")

        max_retries = (retries if retries is not None else self.default_retries) if auto_retry else 0
        delay = retry_delay if retry_delay is not None else self.default_retry_delay

        payload = {
            "utr": clean_utr,
            "expected_amount": float(expected_amount),
            "order_id": order_id,
            "mark_as_read": mark_as_read
        }

        attempt = 0
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            while True:
                attempt += 1
                try:
                    resp = await client.post(
                        f"{self.worker_url}/verify",
                        headers=self._headers(),
                        json=payload
                    )
                    data = resp.json()

                    if resp.status_code == 200 and data.get("success"):
                        return VerificationResult(
                            success=True,
                            status="VERIFIED",
                            amount=data.get("amount"),
                            sender=data.get("sender"),
                            utr=data.get("utr"),
                            txn_id=data.get("txn_id"),
                            order_id=data.get("order_id"),
                            attempts=attempt,
                            raw=data
                        )

                    status = data.get("status", "UNKNOWN")
                    if status == "PENDING" and attempt <= max_retries:
                        if on_poll:
                            on_poll(attempt, max_retries)
                        await asyncio.sleep(delay)
                        continue

                    return VerificationResult(
                        success=False,
                        status=status,
                        amount=data.get("amount_received"),
                        sender=data.get("sender"),
                        utr=data.get("utr") or clean_utr,
                        txn_id=data.get("txn_id"),
                        order_id=data.get("order_id") or order_id,
                        message=data.get("message"),
                        attempts=attempt,
                        raw=data
                    )

                except Exception as exc:
                    if attempt <= max_retries:
                        if on_poll:
                            on_poll(attempt, max_retries)
                        await asyncio.sleep(delay)
                        continue
                    return VerificationResult(
                        success=False,
                        status="NETWORK_ERROR",
                        message=f"Request error: {str(exc)}",
                        attempts=attempt
                    )
