"""
Unit tests for data models and exceptions.
"""

import unittest
from mobile_money_stellar.exceptions import (
    AuthenticationError,
    BridgeError,
    NotFoundError,
    ValidationError,
)
from mobile_money_stellar.models import (
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


class TestModels(unittest.TestCase):
    def test_auth_models(self):
        req = AuthRequest(account="GBBD47IF...", home_domain="stellarwave.io")
        self.assertEqual(req.account, "GBBD47IF...")
        self.assertEqual(req.home_domain, "stellarwave.io")

        resp = AuthResponse(challenge_xdr="mock-xdr", network_passphrase="Test")
        self.assertEqual(resp.challenge_xdr, "mock-xdr")
        self.assertEqual(resp.network_passphrase, "Test")

    def test_customer_models(self):
        req = CustomerRequest(
            account="GBBD47IF...",
            first_name="Amina",
            last_name="Diallo",
            email_address="amina@example.com",
            mobile_number="+237671234567",
        )
        self.assertEqual(req.first_name, "Amina")
        self.assertEqual(req.email_address, "amina@example.com")

        resp = CustomerResponse(id="cust-123", status="ACCEPTED")
        self.assertEqual(resp.id, "cust-123")
        self.assertEqual(resp.status, "ACCEPTED")

    def test_quote_models(self):
        req = QuoteRequest(
            sell_asset="iso4217:XAF",
            buy_asset="stellar:USDC:GBBD47IF...",
            sell_amount="60250",
        )
        self.assertEqual(req.sell_amount, "60250")

        resp = QuoteResponse(
            id="quote-123",
            price="600.0",
            sell_asset="iso4217:XAF",
            sell_amount="60250",
            buy_asset="stellar:USDC:GBBD47IF...",
            buy_amount="100.0",
            expires_at="2026-10-01T00:00:00Z",
        )
        self.assertEqual(resp.price, "600.0")

    def test_deposit_and_status_models(self):
        req = DepositRequest(
            asset_code="USDC",
            account="GBBD47IF...",
            amount="100.0",
            provider="mtn",
        )
        self.assertEqual(req.provider, "mtn")

        resp = DepositResponse(
            url="https://bridge.stellarwave.io/sep24/flow?token=123",
            id="tx-123",
        )
        self.assertEqual(resp.id, "tx-123")
        self.assertEqual(resp.status, "pending_user_transfer_start")

        status = TransactionStatusResponse(id="tx-123", status="completed", amount_out="100.0")
        self.assertEqual(status.status, "completed")
        self.assertEqual(status.amount_out, "100.0")

    def test_exceptions_hierarchy(self):
        err = ValidationError("Bad input", details={"field": "account"})
        self.assertEqual(err.status_code, 400)
        self.assertEqual(err.code, "VALIDATION_ERROR")
        self.assertIn("Bad input", str(err))

        auth_err = AuthenticationError("Unauthorized")
        self.assertEqual(auth_err.status_code, 401)

        nf_err = NotFoundError("Missing")
        self.assertEqual(nf_err.status_code, 404)

        base_err = BridgeError("Generic error", status_code=500)
        self.assertEqual(base_err.status_code, 500)
        self.assertIn("[500]", str(base_err))


if __name__ == "__main__":
    unittest.main()
