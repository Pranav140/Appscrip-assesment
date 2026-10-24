# Device Communication Protocol

This document details the HTTP batch ingestion protocol between field devices and the RTOps platform.

## Ingestion Endpoint
`POST /v1/events`

### Request Headers
- `Content-Type: application/json`
- `X-Device-Id: <string>` (Unique device identifier, e.g. `dev-001`)
- `X-Device-Key: <string>` (Raw secret provisioned for the device)

### Request Body Schema
A batch array containing between 1 and 500 events:
```json
{
  "events": [
    {
      "event_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "device_id": "dev-001",
      "seq": 42,
      "type": "telemetry",
      "ts": "2026-10-24T12:00:00.000Z",
      "payload": {
        "temperature": 82.4,
        "humidity": 45.2,
        "battery": 88
      },
      "schema_version": 1
    }
  ]
}
```

### Response Schema (200 OK)
The server acknowledges each event independently:
```json
{
  "results": [
    {
      "event_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "status": "accepted"
    },
    {
      "event_id": "c82ef91a-1234-4567-89ab-cdef01234567",
      "status": "duplicate"
    },
    {
      "event_id": "malformed-event-id",
      "status": "rejected",
      "reason": "Payload validation failed: temperature is missing"
    }
  ]
}
```

## Device Buffer & Retention Rules
1. **Accepted / Duplicate**: The device **MUST** delete the acknowledged event from its local durable buffer.
2. **Rejected**: Permanent error (e.g., malformed schema or invalid device ID). The device **MUST** drop the event to avoid retry loops.
3. **HTTP 429 (Too Many Requests)**: Server queue depth high watermark exceeded. The device **MUST** retain all events in its local buffer and wait for the duration specified in the `Retry-After: <seconds>` response header.
4. **HTTP 5xx / Network Drops**: The device **MUST** retain the batch in its local disk buffer and retry with exponential backoff and randomized jitter.

## Example Ingestion via Curl
```bash
curl -X POST http://localhost:3000/v1/events \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: dev-001" \
  -H "X-Device-Key: rtops_key_dev-001_demo_secret" \
  -d '{
    "events": [
      {
        "event_id": "a50c822e-bf73-45a8-bd23-d81b498f3b25",
        "device_id": "dev-001",
        "seq": 1,
        "type": "telemetry",
        "ts": "2026-10-24T13:00:00.000Z",
        "payload": { "temperature": 84.5, "battery": 92 },
        "schema_version": 1
      }
    ]
  }'
```
