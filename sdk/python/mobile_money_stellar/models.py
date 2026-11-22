"""
Pydantic data models for mobile_money_stellar Python SDK.
"""

from typing import Any, Dict, Optional

try:
    from pydantic import BaseModel, Field
except ImportError:
    # Minimal fallback to support running in lightweight Python test environments without pydantic
    class BaseModel:
        def __init__(self, **kwargs: Any):
            for k, v in kwargs.items():
                setattr(self, k, v)

        def dict(self) -> Dict[str, Any]:
            return {k: v for k, v in self.__dict__.items() if not k.startswith("_")}

        def model_dump(self) -> Dict[str, Any]:
            return self.dict()

        def __repr__(self) -> str:
            attrs = ", ".join(f"{k}={v!r}" for k, v in self.__dict__.items() if not k.startswith("_"))
            return f"{self.__class__.__name__}({attrs})"

    def Field(*args: Any, **kwargs: Any) -> Any:
        return kwargs.get("default", None)


class AuthRequest(BaseModel):
    account: str
    home_domain: Optional[str] = None
    signed_transaction_xdr: Optional[str] = None


class AuthResponse(BaseModel):
    token: Optional[str] = None
    challenge_xdr: Optional[str] = None
    network_passphrase: Optional[str] = None


class CustomerRequest(BaseModel):
    account: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email_address: Optional[str] = None
    mobile_number: Optional[str] = None
    customer_type: Optional[str] = None


class CustomerResponse(BaseModel):
    id: str
    status: str
    fields: Optional[Dict[str, Any]] = None
    message: Optional[str] = None


class QuoteRequest(BaseModel):
    sell_asset: str
    buy_asset: str
    sell_amount: Optional[str] = None
    buy_amount: Optional[str] = None
    context: Optional[str] = "sep24"
    expire_after: Optional[str] = None


class QuoteResponse(BaseModel):
    id: str
    price: str
    total_price: Optional[str] = None
    sell_asset: str
    sell_amount: str
    buy_asset: str
    buy_amount: str
    expires_at: str
    fee: Optional[Dict[str, Any]] = None


class DepositRequest(BaseModel):
    asset_code: str
    account: str
    amount: Optional[str] = None
    phone_number: Optional[str] = None
    provider: Optional[str] = None
    client_domain: Optional[str] = None


class DepositResponse(BaseModel):
    url: str
    id: str
    status: str = "pending_user_transfer_start"
    type: str = "interactive_customer_info_needed"


class TransactionStatusResponse(BaseModel):
    id: str
    status: str
    amount_in: Optional[str] = None
    amount_out: Optional[str] = None
    amount_fee: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    message: Optional[str] = None
