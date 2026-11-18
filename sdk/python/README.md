# fampay_worker

Python client library for verifying FamApp UPI payments via Cloudflare Worker.

## Installation

```bash
pip install fampay-worker
```

Or copy the `fampay_worker` folder directly into your backend project.

## Quickstart

### Synchronous Usage

```python
from fampay_worker import FamPayGateway

gateway = FamPayGateway(
    worker_url="https://your-worker.workers.dev",
    api_key="your-api-key"  # Optional
)

# Verify payment with auto-retry (3 attempts, 3s interval)
verification = gateway.verify(
    utr="319105912273",
    expected_amount=100.0,
    order_id="ORD_123",
    auto_retry=True
)

if verification.is_verified:
    print(f"Payment received: ₹{verification.amount} from {verification.sender}")
    print(f"FamApp Txn ID: {verification.txn_id}")
elif verification.is_already_claimed:
    print("Warning: UTR was already claimed!")
else:
    print(f"Verification failed: {verification.status} - {verification.message}")
```

### Asynchronous Usage (FastAPI, Starlette, asyncio)

```python
import asyncio
from fampay_worker import AsyncFamPayGateway

async def verify_payment():
    gateway = AsyncFamPayGateway(worker_url="https://your-worker.workers.dev")
    
    result = await gateway.verify(
        utr="319105912273",
        expected_amount=100.0,
        order_id="ORD_123",
        auto_retry=True,
        retries=3,
        retry_delay=3.0
    )
    
    if result.is_verified:
        print(f"Verified ₹{result.amount} from {result.sender}")
    return result

# asyncio.run(verify_payment())
```
