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
3. Logstash applies the Elasticsearch template with ILM policy and writes to a managed
   rollover alias (`mobile-money-logs`), creating new indices every 30 days.
4. Kibana imports a starter dashboard automatically.

## ILM Policy Setup

Before running the ELK stack, deploy the ILM policy to Elasticsearch:

**On Unix/Linux/macOS:**
```bash
sh elk/scripts/apply-ilm-policy.sh
```

**On Windows PowerShell:**
```powershell
powershell -File .\elk\scripts\apply-ilm-policy.ps1
```

For container Elasticsearch, set the URL:
```bash
ELASTICSEARCH_URL=http://elasticsearch:9200 sh elk/scripts/apply-ilm-policy.sh
```

The policy rolls logs over after 30 days and deletes them after 90 days to save storage.

In local development, the structured log mirror also rolls by size into dated
shards and compresses archived shards as `.gz` files so the working log
directory does not grow without bound.

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
