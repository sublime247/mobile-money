param(
  [string]$ElasticUrl = $(if ($env:ELASTICSEARCH_URL) { $env:ELASTICSEARCH_URL } else { 'http://localhost:9200' }),
  [string]$PolicyFile = $(if ($env:POLICY_FILE) { $env:POLICY_FILE } else { Join-Path (Split-Path -Path $PSScriptRoot -Parent) 'ilm\mobile-money-logs-policy.json' })
)

Write-Host "Applying ILM policy from $PolicyFile to $ElasticUrl"

while ($true) {
  try {
    Invoke-WebRequest -Uri $ElasticUrl -Method Head -UseBasicParsing -TimeoutSec 5 | Out-Null
    break
  } catch {
    Write-Host "Waiting for Elasticsearch at $ElasticUrl..."
    Start-Sleep -Seconds 5
  }
}

$body = Get-Content -Path $PolicyFile -Raw
Invoke-WebRequest -Uri "$ElasticUrl/_ilm/policy/mobile-money-logs-policy" -Method Put -ContentType 'application/json' -Body $body -UseBasicParsing
Write-Host "ILM policy applied successfully."
