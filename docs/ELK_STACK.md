# ELK Log Indexing

This repository ships application logs into Elasticsearch through Filebeat and
Logstash.

## What Gets Indexed

- Request completion logs from `requestLogger`
- Existing `console.*` output, normalized into ECS-style JSON
- Slow-query logs and runtime errors
- Session anomaly audit events

## Local Stack

Start the full stack:

```bash
docker compose up --build
```

Endpoints:

- App: `http://localhost:3000`
- Elasticsearch: `http://localhost:9200`
- Kibana: `http://localhost:5601`

## How It Works

1. The Node app writes structured JSON to stdout/stderr and to
   `/var/log/mobile-money/app.log`.
2. Filebeat tails that file and forwards NDJSON events to Logstash.
3. Logstash applies the Elasticsearch template and writes daily indices named
   `mobile-money-logs-YYYY.MM.dd`.
4. Kibana imports a starter dashboard automatically.

## Useful Queries

- `event.dataset : "http.request"`
- `log.level : "error"`
- `message : "*timeout*"`
- `path : "/health"`

## Traffic Dashboard

The imported dashboard is `Mobile Money Observability`.

It includes:

- Request volume over time
- HTTP status code breakdown

## Notes

- This setup disables Elasticsearch security for local development.
- The log template maps `log.level` as a keyword and `message` as full text for
  fast filtering plus free-text search.
