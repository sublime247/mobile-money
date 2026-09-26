"""
Unit tests for asynchronous AsyncStellarBridgeClient.
"""

import unittest
from mobile_money_stellar.async_client import AsyncStellarBridgeClient
from mobile_money_stellar.exceptions import ValidationError
from mobile_money_stellar.models import CustomerRequest, DepositRequest, QuoteRequest


class TestAsyncStellarBridgeClient(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncStellarBridgeClient(base_url="https://api.bridge.stellarwave.io")

    async def test_init_validation(self):
        with self.assertRaises(ValidationError):
            AsyncStellarBridgeClient(base_url="")

    async def test_async_mock_operations(self):
        mock_data = {
            "/sep10/auth": {
                "GET": {"transaction": "AAAAAgAAAABmockChallenge...", "network_passphrase": "Test Network"},
                "POST": {"token": "jwt-token-async"},
            },
            "/sep12/customer": {
                "PUT": {"id": "cust-async-123", "status": "ACCEPTED"},
            },
            "/sep38/quote": {
                "POST": {
                    "id": "quote-async-456",
                    "price": "600.0",
                    "sell_asset": "iso4217:XAF",
                    "sell_amount": "60250",
                    "buy_asset": "stellar:USDC:GBBD47IF...",
                    "buy_amount": "100.0",
                    "expires_at": "2026-10-01T12:00:00Z",
                },
            },
            "/sep24/transactions/deposit/interactive": {
                "POST": {
                    "url": "https://bridge.stellarwave.io/sep24/flow?token=deposit-async",
                    "id": "tx-async-101",
                    "status": "pending_user_transfer_start",
                },
            },
            "/sep24/transaction": {
                "GET": {
                    "transaction": {
                        "id": "tx-async-101",
                        "status": "completed",
                        "amount_in": "60250",
                        "amount_out": "100.0",
                    }
                }
            },
        }

        async def mock_transport(method, path, params=None, data=None):
            route = mock_data.get(path, {})
            return route.get(method, {})

        self.client._custom_transport = mock_transport

        # Context manager test
        async with self.client as client:
            # 1. Auth step 1
            auth1 = await client.auth("GBBD47IF...")
            self.assertEqual(auth1.challenge_xdr, "AAAAAgAAAABmockChallenge...")

            # 2. Auth step 2
            auth2 = await client.auth("GBBD47IF...", signed_transaction_xdr="mock-sig")
            self.assertEqual(auth2.token, "jwt-token-async")

            # 3. Customer
            cust = await client.create_customer(CustomerRequest(account="GBBD47IF..."))
            self.assertEqual(cust.id, "cust-async-123")

            # 4. Quote
            quote = await client.get_quote(
                QuoteRequest(
                    sell_asset="iso4217:XAF",
                    buy_asset="stellar:USDC:GBBD47IF...",
                    sell_amount="60250",
                )
            )
            self.assertEqual(quote.id, "quote-async-456")

            # 5. Deposit
            dep = await client.initiate_deposit(
                DepositRequest(asset_code="USDC", account="GBBD47IF...")
            )
            self.assertEqual(dep.id, "tx-async-101")

            # 6. Status
            status = await client.get_transaction_status("tx-async-101")
            self.assertEqual(status.status, "completed")


if __name__ == "__main__":
    unittest.main()
