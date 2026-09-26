# mobile-money-stellar

Official Python SDK for the Mobile Money Stellar Bridge API.

Provides typed synchronous and asynchronous clients with Pydantic models for seamless backend fintech and Django integrations.

## Features

* **Pydantic Type Safety**: Full request and response validation models
* **Dual Transport**: Synchronous (`StellarBridgeClient`) and Asynchronous (`AsyncStellarBridgeClient`) via `httpx` and `asyncio`
* **SEP Protocols**:
  * **SEP-10**: Stellar Web Authentication & JWT issuance
  * **SEP-12**: Customer KYC registration and status query
  * **SEP-24**: Interactive deposit & withdrawal webview flow
  * **SEP-38**: Guaranteed price quotes for off-chain to on-chain conversions

## Installation

```bash
pip install mobile-money-stellar
```

## Quick Start

### Synchronous Usage

```python
from mobile_money_stellar import StellarBridgeClient, DepositRequest

client = StellarBridgeClient(base_url="https://api.bridge.stellarwave.io")

# 1. SEP-10 Auth
challenge = client.auth(account="GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5")
print(challenge.challenge_xdr)

# 2. SEP-24 Initiate Deposit
deposit = client.initiate_deposit(
    DepositRequest(
        asset_code="USDC",
        account="GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        amount="100.0",
        phone_number="+237671234567",
        provider="mtn",
    )
)
print(deposit.url)
```

### Asynchronous Usage (FastAPI, Django async, asyncio)

```python
import asyncio
from mobile_money_stellar import AsyncStellarBridgeClient, QuoteRequest

async def main():
    async with AsyncStellarBridgeClient(base_url="https://api.bridge.stellarwave.io") as client:
        quote = await client.get_quote(
            QuoteRequest(
                sell_asset="iso4217:XAF",
                buy_asset="stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                sell_amount="60250",
            )
        )
        print(quote.price, quote.expires_at)

asyncio.run(main())
```

## Running Tests

```bash
pytest
```
