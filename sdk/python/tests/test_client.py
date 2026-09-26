"""
Unit tests for synchronous StellarBridgeClient.
"""

import unittest
from mobile_money_stellar.client import StellarBridgeClient
from mobile_money_stellar.exceptions import ValidationError
from mobile_money_stellar.models import CustomerRequest, DepositRequest, QuoteRequest


class TestStellarBridgeClient(unittest.TestCase):
    def setUp(self):
        self.client = StellarBridgeClient(base_url="https://api.bridge.stellarwave.io")

    def test_init_validation(self):
        with self.assertRaises(ValidationError):
            StellarBridgeClient(base_url="")

    def test_jwt_token_handling(self):
        self.assertIsNone(self.client.get_jwt_token())
        self.client.set_jwt_token("test-token-xyz")
        self.assertEqual(self.client.get_jwt_token(), "test-token-xyz")
        headers = self.client._get_headers()
        self.assertEqual(headers["Authorization"], "Bearer test-token-xyz")

    def test_mock_operations(self):
        mock_data = {
            "/sep10/auth": {
                "GET": {"transaction": "AAAAAgAAAABmockChallenge...", "network_passphrase": "Test Network"},
                "POST": {"token": "jwt-token-999"},
            },
            "/sep12/customer": {
                "PUT": {"id": "cust-uuid-456", "status": "ACCEPTED", "message": "Verified"},
            },
            "/sep38/quote": {
                "POST": {
                    "id": "quote-uuid-789",
                    "price": "600.0",
                    "total_price": "602.5",
                    "sell_asset": "iso4217:XAF",
                    "sell_amount": "60250",
                    "buy_asset": "stellar:USDC:GBBD47IF...",
                    "buy_amount": "100.0",
                    "expires_at": "2026-10-01T12:00:00Z",
                },
            },
            "/sep24/transactions/deposit/interactive": {
                "POST": {
                    "url": "https://bridge.stellarwave.io/sep24/flow?token=deposit-token-456",
                    "id": "tx-sep24-456",
                    "status": "pending_user_transfer_start",
                },
            },
            "/sep24/transaction": {
                "GET": {
                    "transaction": {
                        "id": "tx-sep24-456",
                        "status": "completed",
                        "amount_in": "60250",
                        "amount_out": "100.0",
                    }
                }
            },
            "/sep24/transactions/withdraw/interactive": {
                "POST": {
                    "url": "https://bridge.stellarwave.io/sep24/flow?token=withdraw-token-789",
                    "id": "tx-sep24-789",
                    "status": "pending_user_transfer_start",
                }
            },
        }

        def mock_transport(method, path, params=None, data=None):
            route = mock_data.get(path, {})
            return route.get(method, {})

        self.client._custom_transport = mock_transport

        # 1. SEP-10 challenge
        auth_step1 = self.client.auth("GBBD47IF...")
        self.assertEqual(auth_step1.challenge_xdr, "AAAAAgAAAABmockChallenge...")

        # 2. SEP-10 exchange
        auth_step2 = self.client.auth(
            account_or_request="GBBD47IF...",
            signed_transaction_xdr="signed-mock-xdr",
        )
        self.assertEqual(auth_step2.token, "jwt-token-999")
        self.assertEqual(self.client.get_jwt_token(), "jwt-token-999")

        # 3. SEP-12 KYC
        cust = self.client.create_customer(
            CustomerRequest(
                account="GBBD47IF...",
                first_name="Amina",
                last_name="Diallo",
            )
        )
        self.assertEqual(cust.id, "cust-uuid-456")
        self.assertEqual(cust.status, "ACCEPTED")

        # 4. SEP-38 Quote
        quote = self.client.get_quote(
            QuoteRequest(
                sell_asset="iso4217:XAF",
                buy_asset="stellar:USDC:GBBD47IF...",
                sell_amount="60250",
            )
        )
        self.assertEqual(quote.id, "quote-uuid-789")
        self.assertEqual(quote.price, "600.0")

        # 5. SEP-24 Deposit
        dep = self.client.initiate_deposit(
            DepositRequest(
                asset_code="USDC",
                account="GBBD47IF...",
                amount="100.0",
                provider="mtn",
            )
        )
        self.assertEqual(dep.id, "tx-sep24-456")
        self.assertIn("sep24/flow", dep.url)

        # 6. SEP-24 Transaction Status
        tx_status = self.client.get_transaction_status("tx-sep24-456")
        self.assertEqual(tx_status.id, "tx-sep24-456")
        self.assertEqual(tx_status.status, "completed")
        self.assertEqual(tx_status.amount_out, "100.0")

        # 7. SEP-24 Withdrawal
        withd = self.client.initiate_withdrawal(
            DepositRequest(
                asset_code="USDC",
                account="GBBD47IF...",
                amount="100.0",
                provider="orange",
            )
        )
        self.assertEqual(withd.id, "tx-sep24-789")


if __name__ == "__main__":
    unittest.main()
