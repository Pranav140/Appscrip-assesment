import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';

export const SystemView: React.FC = () => {
  const queryClient = useQueryClient();

  const { data: failedData } = useQuery({
    queryKey: ['failed-events'],
    queryFn: () => api.getFailedEvents(),
    refetchInterval: 5000,
  });

  const { data: rejectedData } = useQuery({
    queryKey: ['rejected-events'],
    queryFn: () => api.getRejectedEvents(),
    refetchInterval: 5000,
  });

  const { data: notificationsData } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.getNotifications(),
    refetchInterval: 5000,
  });

  const retryEventMutation = useMutation({
    mutationFn: (seq: number) => api.retryEvent(seq),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['failed-events'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  const retryNotifMutation = useMutation({
    mutationFn: (id: number) => api.retryNotification(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const failedEvents = failedData?.failed_events ?? [];
  const rejectedEvents = rejectedData?.rejected_events ?? [];
  const notifications = notificationsData?.notifications ?? [];

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>System Health & Dead-Letter Queues</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
          Inspect malformed payloads, poison pill events exceeding retry limits, and webhook notification outbox state.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {/* Failed Events (DLQ) */}
        <div className="glass-panel" style={{ padding: 20 }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 4 }}>
            Dead-Lettered Events ({failedEvents.length})
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 16 }}>
            Events that exceeded MAX_ATTEMPTS (5) and were isolated from blocking the queue.
          </p>

          <table className="data-table">
            <thead>
              <tr>
                <th>Seq</th>
                <th>Device ID</th>
                <th>Attempts</th>
                <th>Last Error</th>
                <th>Processed At</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {failedEvents.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 20, color: 'var(--accent-green)' }}>
                    ✓ No dead-lettered events. All event processing is clean.
                  </td>
                </tr>
              ) : (
                failedEvents.map((e: any) => (
                  <tr key={e.ingest_seq}>
                    <td className="font-mono">#{e.ingest_seq}</td>
                    <td className="font-mono">{e.device_id}</td>
                    <td>{e.attempts}</td>
                    <td style={{ color: 'var(--accent-red)', fontSize: '0.8rem' }}>{e.last_error}</td>
                    <td className="font-mono" style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      {e.processed_at ? new Date(e.processed_at).toLocaleString() : '—'}
                    </td>
                    <td>
                      <button
                        className="btn-primary"
                        style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                        onClick={() => retryEventMutation.mutate(e.ingest_seq)}
                      >
                        Re-queue
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Rejected Events (Malformed) */}
        <div className="glass-panel" style={{ padding: 20 }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 4 }}>
            Rejected Events ({rejectedEvents.length})
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 16 }}>
            Malformed payloads that failed Zod validation at ingestion, stored for operator debugging.
          </p>

          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Device ID</th>
                <th>Reason</th>
                <th>Received At</th>
                <th>Raw Payload</th>
              </tr>
            </thead>
            <tbody>
              {rejectedEvents.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>
                    No rejected events.
                  </td>
                </tr>
              ) : (
                rejectedEvents.map((r: any) => (
                  <tr key={r.id}>
                    <td className="font-mono">#{r.id}</td>
                    <td className="font-mono">{r.device_id ?? 'Unknown'}</td>
                    <td style={{ color: 'var(--accent-amber)', fontSize: '0.85rem' }}>{r.reason}</td>
                    <td className="font-mono" style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      {new Date(r.received_at).toLocaleTimeString()}
                    </td>
                    <td>
                      <pre className="font-mono" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        {JSON.stringify(r.raw)}
                      </pre>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Notification Outbox */}
        <div className="glass-panel" style={{ padding: 20 }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 4 }}>
            Notification Outbox Status ({notifications.length})
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 16 }}>
            Transactional outbox entries. Protected by circuit breaker and exponential backoff.
          </p>

          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Incident</th>
                <th>Channel</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Idempotency Key</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {notifications.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>
                    No notifications in outbox.
                  </td>
                </tr>
              ) : (
                notifications.map((n: any) => (
                  <tr key={n.id}>
                    <td className="font-mono">#{n.id}</td>
                    <td className="font-mono">#{n.incident_id}</td>
                    <td>{n.channel}</td>
                    <td>
                      <span
                        className="status-pill"
                        style={{
                          background:
                            n.status === 'sent'
                              ? 'rgba(16, 185, 129, 0.2)'
                              : n.status === 'dead'
                              ? 'rgba(239, 68, 68, 0.2)'
                              : 'rgba(245, 158, 11, 0.2)',
                          color:
                            n.status === 'sent'
                              ? 'var(--accent-green)'
                              : n.status === 'dead'
                              ? 'var(--accent-red)'
                              : 'var(--accent-amber)',
                        }}
                      >
                        {n.status}
                      </span>
                    </td>
                    <td>{n.attempts}</td>
                    <td className="font-mono" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {n.idempotency_key}
                    </td>
                    <td>
                      {n.status === 'dead' && (
                        <button
                          className="btn-secondary"
                          style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                          onClick={() => retryNotifMutation.mutate(n.id)}
                        >
                          Retry Delivery
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
