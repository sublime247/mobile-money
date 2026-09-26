"""
Asynchronous Python client for Mobile Money Bridge API (asyncio / httpx).
"""

import asyncio
from typing import Any, Dict, Optional, Union

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


class AsyncStellarBridgeClient:
    """
    Asynchronous client for interacting with the Stellar Mobile Money Bridge API.
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

    async def __aenter__(self) -> "AsyncStellarBridgeClient":
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        pass

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

    async def _request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if self._custom_transport:
            if asyncio.iscoroutinefunction(self._custom_transport):
                return await self._custom_transport(method, path, params, data)
            return self._custom_transport(method, path, params, data)

        try:
            import httpx

            async with httpx.AsyncClient(timeout=self.timeout) as client:
                url = f"{self.base_url}{path}"
                resp = await client.request(
                    method=method,
                    url=url,
                    params=params,
                    json=data,
                    headers=self._get_headers(),
                )
                if resp.status_code == 400:
                    raise ValidationError(resp.text)
                elif resp.status_code == 401:
                    raise AuthenticationError(resp.text)
                elif resp.status_code == 404:
                    raise NotFoundError(resp.text)
                elif resp.status_code >= 400:
                    raise BridgeError(resp.text, status_code=resp.status_code)
                return resp.json()
        except ImportError:
            # Fallback for environments where httpx is not yet installed
            from .client import StellarBridgeClient

            sync_client = StellarBridgeClient(
                base_url=self.base_url,
                jwt_token=self.jwt_token,
                timeout=self.timeout,
                headers=self.headers,
            )
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(
                None, sync_client._request, method, path, params, data
            )

    async def auth(
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
            res = await self._request(
                "POST",
                "/sep10/auth",
                data={"transaction": req.signed_transaction_xdr},
            )
            token = res.get("token")
            if token:
                self.jwt_token = token
            return AuthResponse(token=token)
        else:
            res = await self._request(
                "GET",
                "/sep10/auth",
                params={"account": req.account, "home_domain": req.home_domain},
            )
            return AuthResponse(
                challenge_xdr=res.get("transaction"),
                network_passphrase=res.get("network_passphrase"),
            )

    async def create_customer(
        self, params: Union[CustomerRequest, Dict[str, Any]]
    ) -> CustomerResponse:
        """SEP-12 KYC customer creation."""
        req = params if isinstance(params, CustomerRequest) else CustomerRequest(**params)
        if not req.account:
            raise ValidationError("account is required to create a customer")

        res = await self._request(
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

    async def get_quote(
        self, params: Union[QuoteRequest, Dict[str, Any]]
    ) -> QuoteResponse:
        """SEP-38 Currency conversion price quote."""
        req = params if isinstance(params, QuoteRequest) else QuoteRequest(**params)
        if not req.sell_asset or not req.buy_asset:
            raise ValidationError("sell_asset and buy_asset are required")

        res = await self._request(
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

    async def initiate_deposit(
        self, params: Union[DepositRequest, Dict[str, Any]]
    ) -> DepositResponse:
        """SEP-24 Interactive Deposit initiation."""
        req = params if isinstance(params, DepositRequest) else DepositRequest(**params)
        if not req.asset_code or not req.account:
            raise ValidationError("asset_code and account are required")

        res = await self._request(
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

    async def get_transaction_status(
        self, transaction_id: str
    ) -> TransactionStatusResponse:
        """SEP-24 Query transaction state."""
        if not transaction_id:
            raise ValidationError("transaction_id is required")

        res = await self._request(
            "GET", "/sep24/transaction", params={"id": transaction_id}
        )
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

    async def initiate_withdrawal(
        self, params: Union[DepositRequest, Dict[str, Any]]
    ) -> DepositResponse:
        """SEP-24 Interactive Withdrawal initiation."""
        req = params if isinstance(params, DepositRequest) else DepositRequest(**params)
        if not req.asset_code or not req.account:
            raise ValidationError("asset_code and account are required")

        res = await self._request(
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
