# Product Brief: Real-Time Operations Platform

## Overview
A real-time operations platform for a fleet of devices operating across multiple geographic locations. Devices continuously produce telemetry and status events, occasionally experience network disconnects, and reconnect by replaying locally buffered events.

## Key Requirements
1. **Fleet Monitoring**: Operators monitor devices in real time, view operational metrics, and inspect historical telemetry.
2. **Rules Engine & Incidents**: Configurable alert rules (threshold, event type, silence) that trigger deduplicated incidents and dispatch notifications to operators.
3. **Resilience & Fault Tolerance**: Must gracefully handle:
   - Out-of-order events
   - Duplicate deliveries
   - Network disconnects and bursty reconnect replay
   - Bursts and platform overload (backpressure)
   - Malformed payloads (isolated without failing healthy events in a batch)
   - Processing worker crashes / restarts
   - Notification service outages
   - Long offline device gaps
4. **Deliverables**:
   - Working frontend and backend
   - Architecture diagram and architectural notes (decisions, alternatives, trade-offs)
   - Tests including failure scenarios
   - Run instructions and deployment notes
   - Lightweight device simulator reproducing real-world edge cases.
