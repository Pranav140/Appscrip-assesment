import React, { useState } from 'react';

interface LiveEventsViewProps {
  liveEvents: any[];
  isPaused: boolean;
  onTogglePause: () => void;
  onClear: () => void;
}

export const LiveEventsView: React.FC<LiveEventsViewProps> = ({
  liveEvents,
  isPaused,
  onTogglePause,
  onClear,
}) => {
  const [typeFilter, setTypeFilter] = useState('');
  const [deviceFilter, setDeviceFilter] = useState('');

  const filtered = liveEvents.filter((e) => {
    if (typeFilter && e.type !== typeFilter) return false;
    if (deviceFilter && !e.device_id.toLowerCase().includes(deviceFilter.toLowerCase())) return false;
    return true;
  });

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Real-Time Ingestion Feed</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            Streaming directly via Server-Sent Events (SSE) with client-side buffer (bounded to 500 events).
          </p>
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <button
            className={isPaused ? 'btn-primary' : 'btn-secondary'}
            onClick={onTogglePause}
            style={{ minWidth: 100 }}
          >
            {isPaused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button className="btn-secondary" onClick={onClear}>
            Clear
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Filter by device ID..."
          value={deviceFilter}
          onChange={(e) => setDeviceFilter(e.target.value)}
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-primary)',
            padding: '8px 14px',
            borderRadius: 8,
            fontSize: '0.875rem',
            width: 220,
          }}
        />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-primary)',
            padding: '8px 14px',
            borderRadius: 8,
            fontSize: '0.875rem',
          }}
        >
          <option value="">All Event Types</option>
          <option value="telemetry">telemetry</option>
          <option value="heartbeat">heartbeat</option>
          <option value="tamper">tamper</option>
          <option value="battery_low">battery_low</option>
        </select>
        <div style={{ alignSelf: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          Showing {filtered.length} of {liveEvents.length} buffered events
        </div>
      </div>

      {/* Events Stream Table */}
      <div className="glass-panel" style={{ overflow: 'hidden' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 100 }}>Seq</th>
              <th style={{ width: 140 }}>Device ID</th>
              <th style={{ width: 120 }}>Event Type</th>
              <th style={{ width: 100 }}>Flags</th>
              <th style={{ width: 140 }}>Device Clock</th>
              <th>Payload</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
                  {liveEvents.length === 0
                    ? 'Waiting for incoming events from fleet devices...'
                    : 'No events match the selected filters.'}
                </td>
              </tr>
            ) : (
              filtered.map((e, idx) => (
                <tr key={e.ingest_seq ?? `${e.event_id}-${idx}`}>
                  <td className="font-mono" style={{ color: 'var(--text-muted)' }}>
                    #{e.ingest_seq ?? e.seq ?? '—'}
                  </td>
                  <td className="font-mono" style={{ fontWeight: 600 }}>
                    {e.device_id}
                  </td>
                  <td>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        background:
                          e.type === 'tamper'
                            ? 'rgba(239, 68, 68, 0.2)'
                            : e.type === 'telemetry'
                            ? 'rgba(6, 182, 212, 0.15)'
                            : 'rgba(255, 255, 255, 0.05)',
                        color:
                          e.type === 'tamper'
                            ? 'var(--accent-red)'
                            : e.type === 'telemetry'
                            ? 'var(--accent-cyan)'
                            : 'var(--text-primary)',
                      }}
                    >
                      {e.type}
                    </span>
                  </td>
                  <td>
                    {e.is_replay && (
                      <span
                        style={{
                          fontSize: '0.7rem',
                          background: 'rgba(245, 158, 11, 0.2)',
                          color: 'var(--accent-amber)',
                          padding: '2px 6px',
                          borderRadius: 4,
                          fontWeight: 600,
                        }}
                      >
                        REPLAY
                      </span>
                    )}
                  </td>
                  <td className="font-mono" style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    {e.event_ts ? new Date(e.event_ts).toLocaleTimeString() : '—'}
                  </td>
                  <td>
                    <pre
                      className="font-mono"
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--text-secondary)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                      }}
                    >
                      {JSON.stringify(e.payload)}
                    </pre>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
