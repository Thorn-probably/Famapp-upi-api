from dataclasses import dataclass, field
from typing import Optional, Dict, Any

@dataclass
class VerificationResult:
    """Represents the result of a FamApp UPI verification attempt."""
    success: bool
    status: str
    amount: Optional[float] = None
    sender: Optional[str] = None
    utr: Optional[str] = None
    txn_id: Optional[str] = None
    order_id: Optional[str] = None
    message: Optional[str] = None
    attempts: int = 1
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def is_verified(self) -> bool:
        """True if the transaction was verified and amount criteria satisfied."""
        return self.success and self.status == "VERIFIED"

    @property
    def is_pending(self) -> bool:
        """True if the transaction email has not yet been detected in Gmail."""
        return self.status == "PENDING"

    @property
    def is_already_claimed(self) -> bool:
        """True if this UTR was previously claimed (anti-replay guard)."""
        return self.status == "ALREADY_CLAIMED"

    @property
    def is_amount_mismatch(self) -> bool:
        """True if the received amount was less than expected."""
        return self.status == "AMOUNT_MISMATCH"

    def __repr__(self) -> str:
        if self.is_verified:
            return f"<VerificationResult VERIFIED utr='{self.utr}' amount={self.amount} sender='{self.sender}'>"
        return f"<VerificationResult status='{self.status}' message='{self.message}'>"
