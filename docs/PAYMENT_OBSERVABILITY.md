# Payment observability and geographic checks

Apply the transaction correlation ID migration before deploying the backend.
The payment creation request's `X-Correlation-ID` is stored on the transaction.
Its WebSocket `transaction.updated` envelope and SSE status events expose
`correlation_id`. Transactions without a stored ID emit `null`.

WebSocket clients may send
`{"type":"subscribe","data":{"transactionId":"...","correlation_id":"..."}}`.
The server echoes the supplied ID in `subscribe.ack` and logs it with the
acknowledgment. Status updates carry the ID saved at payment creation.

Set `SLACK_ALERT_WEBHOOK_URL` to the on-call channel's incoming webhook.
Redis tracks the 401/403 streak for each provider. The third response in a
streak sends a Slack alert. Any other HTTP response ends the streak.

Set `MAXMIND_GEOIP_DB_PATH` to a local GeoLite2 City database to maintain
current country and coordinate data. Without an explicit path, payment
checks use the bundled local GeoIP data. The payment denylist resides in
`src/config/compliance.ts`. Payment IP checks rely on Express's trusted
proxy configuration, so `TRUST_PROXY` must match the deployment's network
topology. Production rejects payments whose IP cannot be geolocated.
