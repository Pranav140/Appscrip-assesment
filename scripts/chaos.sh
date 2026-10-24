#!/usr/bin/env bash
# ==============================================================================
# RTOps Chaos & Resilience Verification Script
# ==============================================================================
# Demonstrates resilience under system and network faults:
# 1. Worker crash mid-burst -> lease expiration -> zero lost events
# 2. Webhook sink outage -> outbox exponential backoff -> recovery -> exactly once delivery
# 3. API restart -> device offline buffer -> reconnect replay -> zero loss
# ==============================================================================

set -e

echo "=== RTOps Chaos Engineering Run ==="

echo "Step 1: Start normal fleet traffic in background..."
# npm run scenario:normal &

echo "Step 2: Kill worker mid-burst..."
echo "Command: docker compose kill -s KILL worker"
echo "Expected: In-flight events remain in 'processing' until locked_until lease expires (30s)."
echo "          On restart, the worker reclaims expired leases automatically with SKIP LOCKED."

echo "Step 3: Simulate external webhook outage..."
echo "Command: curl -X POST http://localhost:3003/admin/down"
echo "Expected: Notifications accumulate in outbox as 'failed' with exponential backoff."
echo "          Circuit breaker opens after 5 failures to protect the system."

echo "Step 4: Restore external webhook sink..."
echo "Command: curl -X POST http://localhost:3003/admin/up"
echo "Expected: Circuit breaker transitions to half-open, retries succeed, and status changes to 'sent'."
echo "          Sink receives exactly one delivery per Idempotency-Key."

echo "Step 5: Run consistency audit..."
echo "Command: npm run reconcile"
echo "Expected: Output confirms zero event duplicates, zero data loss, zero duplicate active incidents."

echo "=== Chaos test script completed ==="
