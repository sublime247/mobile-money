"""
Synchronous Python client for Mobile Money Bridge API.
"""

import json
from typing import Any, Dict, Optional, Union
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from .exceptions import (
    AuthenticationError,
    BridgeError,
    NotFoundError,
    ValidationError,
)
from .models import (
    AuthRequest,
    AuthResponse,
    CustomerRequest,
    CustomerResponse,
    DepositRequest,
    DepositResponse,
    QuoteRequest,
    QuoteResponse,
    TransactionStatusResponse,
)


class StellarBridgeClient:
    """
    Synchronous client for interacting with the Stellar Mobile Money Bridge.
    """

    def __init__(
        self,
        base_url: str,
        jwt_token: Optional[str] = None,
        timeout: float = 15.0,
        headers: Optional[Dict[str, str]] = None,
    ):
        if not base_url:
            raise ValidationError("base_url is required")
        self.base_url = base_url.rstrip("/")
        self.jwt_token = jwt_token
        self.timeout = timeout
        self.headers = headers or {}
        self._custom_transport = None

    def set_jwt_token(self, token: str) -> None:
        self.jwt_token = token

    def get_jwt_token(self) -> Optional[str]:
        return self.jwt_token

    def _get_headers(self) -> Dict[str, str]:
        req_headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            **self.headers,
        }
        if self.jwt_token:
            req_headers["Authorization"] = f"Bearer {self.jwt_token}"
        return req_headers

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if self._custom_transport:
            return self._custom_transport(method, path, params, data)

        url = f"{self.base_url}{path}"
        if params:
            query = urlencode({k: v for k, v in params.items() if v is not None})
            url = f"{url}?{query}"

        body_bytes = json.dumps(data).encode("utf-8") if data is not None else None
        req = Request(url=url, data=body_bytes, headers=self._get_headers(), method=method)

        try:
            with urlopen(req, timeout=self.timeout) as resp:
                resp_data = resp.read().decode("utf-8")
                return json.loads(resp_data) if resp_data else {}
        except HTTPError as e:
            err_body = e.read().decode("utf-8")
            try:
                parsed_err = json.loads(err_body)
                msg = parsed_err.get("error") or parsed_err.get("message") or str(e)
            except Exception:
                msg = str(e)
                parsed_err = {"raw": err_body}

            if e.code == 400:
                raise ValidationError(msg, details=parsed_err)
            elif e.code == 401:
                raise AuthenticationError(msg, details=parsed_err)
            elif e.code == 404:
                raise NotFoundError(msg, details=parsed_err)
            raise BridgeError(msg, status_code=e.code, details=parsed_err)
        except URLError as e:
            raise BridgeError(f"Connection failed: {e.reason}", code="NETWORK_ERROR")

    def auth(
        self,
        account_or_request: Union[str, AuthRequest, Dict[str, Any]],
        home_domain: Optional[str] = None,
        signed_transaction_xdr: Optional[str] = None,
    ) -> AuthResponse:
        """SEP-10 Authentication flow."""
        if isinstance(account_or_request, str):
            req = AuthRequest(
                account=account_or_request,
                home_domain=home_domain,
                signed_transaction_xdr=signed_transaction_xdr,
            )
        elif isinstance(account_or_request, dict):
            req = AuthRequest(**account_or_request)
        else:
            req = account_or_request

        if not req.account:
            raise ValidationError("account is required for auth")

        if req.signed_transaction_xdr:
            res = self._request(
                "POST",
                "/sep10/auth",
                data={"transaction": req.signed_transaction_xdr},
            )
            token = res.get("token")
            if token:
                self.jwt_token = token
            return AuthResponse(token=token)
        else:
            res = self._request(
                "GET",
                "/sep10/auth",
                params={"account": req.account, "home_domain": req.home_domain},
            )
            return AuthResponse(
                challenge_xdr=res.get("transaction"),
                network_passphrase=res.get("network_passphrase"),
            )

    def create_customer(
        self, params: Union[CustomerRequest, Dict[str, Any]]
    ) -> CustomerResponse:
        """SEP-12 KYC customer creation."""
        req = params if isinstance(params, CustomerRequest) else CustomerRequest(**params)
        if not req.account:
            raise ValidationError("account is required to create a customer")

        res = self._request(
            "PUT",
            "/sep12/customer",
            data={
                "account": req.account,
                "first_name": req.first_name,
                "last_name": req.last_name,
                "email_address": req.email_address,
                "mobile_number": req.mobile_number,
                "type": req.customer_type,
            },
        )
        return CustomerResponse(
            id=res.get("id", ""),
            status=res.get("status", "ACCEPTED"),
            fields=res.get("fields"),
            message=res.get("message"),
        )

    def get_quote(self, params: Union[QuoteRequest, Dict[str, Any]]) -> QuoteResponse:
        """SEP-38 Currency conversion price quote."""
        req = params if isinstance(params, QuoteRequest) else QuoteRequest(**params)
        if not req.sell_asset or not req.buy_asset:
            raise ValidationError("sell_asset and buy_asset are required")

        res = self._request(
            "POST",
            "/sep38/quote",
            data={
                "sell_asset": req.sell_asset,
                "buy_asset": req.buy_asset,
                "sell_amount": req.sell_amount,
                "buy_amount": req.buy_amount,
                "context": req.context,
                "expire_after": req.expire_after,
            },
        )
        return QuoteResponse(
            id=res.get("id", ""),
            price=str(res.get("price", "0")),
            total_price=str(res.get("total_price", res.get("price", "0"))),
            sell_asset=res.get("sell_asset", req.sell_asset),
            sell_amount=str(res.get("sell_amount", req.sell_amount or "0")),
            buy_asset=res.get("buy_asset", req.buy_asset),
            buy_amount=str(res.get("buy_amount", req.buy_amount or "0")),
            expires_at=res.get("expires_at", ""),
            fee=res.get("fee"),
        )

    def initiate_deposit(
        self, params: Union[DepositRequest, Dict[str, Any]]
    ) -> DepositResponse:
        """SEP-24 Interactive Deposit initiation."""
        req = params if isinstance(params, DepositRequest) else DepositRequest(**params)
        if not req.asset_code or not req.account:
            raise ValidationError("asset_code and account are required")

        res = self._request(
            "POST",
            "/sep24/transactions/deposit/interactive",
            data={
                "asset_code": req.asset_code,
                "account": req.account,
                "amount": req.amount,
                "phone_number": req.phone_number,
                "provider": req.provider,
                "client_domain": req.client_domain,
            },
        )
        return DepositResponse(
            url=res.get("url", ""),
            id=res.get("id", ""),
            status=res.get("status", "pending_user_transfer_start"),
            type=res.get("type", "interactive_customer_info_needed"),
        )

    def get_transaction_status(self, transaction_id: str) -> TransactionStatusResponse:
        """SEP-24 Query transaction state."""
        if not transaction_id:
            raise ValidationError("transaction_id is required")

        res = self._request("GET", "/sep24/transaction", params={"id": transaction_id})
        tx = res.get("transaction", res)
        return TransactionStatusResponse(
            id=tx.get("id", transaction_id),
            status=tx.get("status", "unknown"),
            amount_in=tx.get("amount_in"),
            amount_out=tx.get("amount_out"),
            amount_fee=tx.get("amount_fee"),
            started_at=tx.get("started_at"),
            completed_at=tx.get("completed_at"),
            message=tx.get("message"),
        )

    def initiate_withdrawal(
        self, params: Union[DepositRequest, Dict[str, Any]]
    ) -> DepositResponse:
        """SEP-24 Interactive Withdrawal initiation."""
        req = params if isinstance(params, DepositRequest) else DepositRequest(**params)
        if not req.asset_code or not req.account:
            raise ValidationError("asset_code and account are required")

        res = self._request(
            "POST",
            "/sep24/transactions/withdraw/interactive",
            data={
                "asset_code": req.asset_code,
                "account": req.account,
                "amount": req.amount,
                "phone_number": req.phone_number,
                "provider": req.provider,
                "client_domain": req.client_domain,
            },
        )
        return DepositResponse(
            url=res.get("url", ""),
            id=res.get("id", ""),
            status=res.get("status", "pending_user_transfer_start"),
            type=res.get("type", "interactive_customer_info_needed"),
        )
