import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api.js';
import type { StreamState } from '../useLiveStream.js';

interface IncidentsViewProps {
  streamState: StreamState;
}

export const IncidentsView: React.FC<IncidentsViewProps> = ({ streamState }) => {
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState('open');
  const [severityFilter, setSeverityFilter] = useState('');
  const [selectedIncidentId, setSelectedIncidentId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: incidentsData, isLoading } = useQuery({
    queryKey: ['incidents', stateFilter, severityFilter],
    queryFn: () =>
      api.getIncidents({
        state: stateFilter || undefined,
        severity: severityFilter || undefined,
      }),
    refetchInterval: 4000,
  });

  const { data: detailData } = useQuery({
    queryKey: ['incident-detail', selectedIncidentId],
    queryFn: () => (selectedIncidentId ? api.getIncident(selectedIncidentId) : null),
    enabled: !!selectedIncidentId,
    refetchInterval: 3000,
  });

  const ackMutation = useMutation({
    mutationFn: (id: number) => api.acknowledgeIncident(id, 'Acknowledged via Operations Console'),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      void queryClient.invalidateQueries({ queryKey: ['incident-detail', selectedIncidentId] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.statusCode === 409) {
        setActionError(`State Conflict (409): ${err.message}`);
      } else {
        setActionError(`Failed to acknowledge: ${String(err)}`);
      }
    },
  });

  const resolveMutation = useMutation({
    mutationFn: (id: number) => api.resolveIncident(id, 'Resolved by Operator in UI'),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      void queryClient.invalidateQueries({ queryKey: ['incident-detail', selectedIncidentId] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.statusCode === 409) {
        setActionError(`State Conflict (409): ${err.message}`);
      } else {
        setActionError(`Failed to resolve: ${String(err)}`);
      }
    },
  });

  const isOffline = streamState === 'offline';
  const incidents = incidentsData?.incidents ?? [];

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Incident Management Console</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            Deduplicated alarms guaranteed by Postgres unique partial constraint. State machine enforces valid transitions.
          </p>
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 12 }}>
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-primary)',
              padding: '8px 14px',
              borderRadius: 8,
              fontSize: '0.875rem',
            }}
          >
            <option value="">All States</option>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
          </select>

          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-primary)',
              padding: '8px 14px',
              borderRadius: 8,
              fontSize: '0.875rem',
            }}
          >
            <option value="">All Severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>

      {actionError && (
        <div
          style={{
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid var(--accent-red)',
            color: '#fca5a5',
            padding: '10px 16px',
            borderRadius: 8,
            marginBottom: 16,
            fontSize: '0.85rem',
          }}
        >
          {actionError}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: selectedIncidentId ? '1fr 450px' : '1fr', gap: 20 }}>
        {/* Incidents Table */}
        <div className="glass-panel" style={{ overflow: 'hidden' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Title</th>
                <th>Device</th>
                <th>Severity</th>
                <th>State</th>
                <th>Matches</th>
                <th>Opened At</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>
                    Loading incidents...
                  </td>
                </tr>
              ) : incidents.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
                    No incidents match criteria.
                  </td>
                </tr>
              ) : (
                incidents.map((inc: any) => (
                  <tr
                    key={inc.id}
                    onClick={() => setSelectedIncidentId(inc.id)}
                    style={{
                      cursor: 'pointer',
                      background: selectedIncidentId === inc.id ? 'rgba(6, 182, 212, 0.08)' : undefined,
                    }}
                  >
                    <td className="font-mono" style={{ color: 'var(--text-muted)' }}>#{inc.id}</td>
                    <td style={{ fontWeight: 600 }}>{inc.title}</td>
                    <td className="font-mono">{inc.device_id}</td>
                    <td>
                      <span
                        style={{
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          color:
                            inc.severity === 'critical'
                              ? 'var(--accent-red)'
                              : inc.severity === 'high'
                              ? 'var(--accent-amber)'
                              : 'var(--accent-cyan)',
                        }}
                      >
                        {inc.severity}
                      </span>
                    </td>
                    <td>
                      <span
                        className="status-pill"
                        style={{
                          background:
                            inc.state === 'open'
                              ? 'rgba(239, 68, 68, 0.2)'
                              : inc.state === 'acknowledged'
                              ? 'rgba(245, 158, 11, 0.2)'
                              : 'rgba(16, 185, 129, 0.2)',
                          color:
                            inc.state === 'open'
                              ? 'var(--accent-red)'
                              : inc.state === 'acknowledged'
                              ? 'var(--accent-amber)'
                              : 'var(--accent-green)',
                        }}
                      >
                        {inc.state}
                      </span>
                    </td>
                    <td className="font-mono" style={{ fontWeight: 700 }}>
                      {inc.occurrence_count}
                    </td>
                    <td className="font-mono" style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      {new Date(inc.opened_at).toLocaleTimeString()}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {inc.state === 'open' && (
                          <button
                            className={`btn-action-ack ${isOffline ? 'btn-disabled' : ''}`}
                            title={isOffline ? 'Offline: reconnect to acknowledge' : 'Acknowledge incident'}
                            onClick={() => ackMutation.mutate(inc.id)}
                          >
                            Ack
                          </button>
                        )}
                        {inc.state !== 'resolved' && (
                          <button
                            className={`btn-action-resolve ${isOffline ? 'btn-disabled' : ''}`}
                            title={isOffline ? 'Offline: reconnect to resolve' : 'Resolve incident'}
                            onClick={() => resolveMutation.mutate(inc.id)}
                          >
                            Resolve
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Incident Detail Drawer */}
        {selectedIncidentId && detailData && (
          <div className="glass-panel" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Incident #{detailData.incident.id}</h2>
              <button
                className="btn-secondary"
                style={{ padding: '2px 8px', fontSize: '0.75rem' }}
                onClick={() => setSelectedIncidentId(null)}
              >
                ✕ Close
              </button>
            </div>

            <div style={{ fontSize: '0.85rem', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div><strong>Title:</strong> {detailData.incident.title}</div>
              <div><strong>Device:</strong> <span className="font-mono">{detailData.incident.device_id}</span></div>
              <div><strong>Dedupe Key:</strong> <span className="font-mono" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{detailData.incident.dedupe_key}</span></div>
              <div><strong>Occurrence Count:</strong> {detailData.incident.occurrence_count} matching events</div>
              <div><strong>Opened:</strong> {new Date(detailData.incident.opened_at).toLocaleString()}</div>
              {detailData.incident.acknowledged_at && (
                <div><strong>Acknowledged:</strong> {new Date(detailData.incident.acknowledged_at).toLocaleString()} by {detailData.incident.acknowledged_by}</div>
              )}
              {detailData.incident.resolved_at && (
                <div><strong>Resolved:</strong> {new Date(detailData.incident.resolved_at).toLocaleString()} by {detailData.incident.resolved_by}</div>
              )}
            </div>

            {/* Why was this incident created? Rule evaluation audit */}
            <hr style={{ borderColor: 'var(--border-subtle)' }} />
            <div>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 8 }}>Audit: Why was this incident created?</h3>
              <div style={{ maxHeight: 150, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {detailData.evaluations?.map((ev: any) => (
                  <div key={ev.id} style={{ padding: '6px 8px', background: 'rgba(255,255,255,0.02)', borderRadius: 4, fontSize: '0.75rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--accent-cyan)' }}>
                      <span>{ev.outcome}</span>
                      <span className="font-mono">{new Date(ev.evaluated_at).toLocaleTimeString()}</span>
                    </div>
                    <div style={{ color: 'var(--text-primary)', marginTop: 2 }}>{ev.reason}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Attached Events */}
            <hr style={{ borderColor: 'var(--border-subtle)' }} />
            <div>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 8 }}>Attached Trigger Events</h3>
              <div style={{ maxHeight: 150, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {detailData.attached_events?.map((e: any) => (
                  <div key={e.ingest_seq} style={{ padding: '6px 8px', background: 'rgba(255,255,255,0.02)', borderRadius: 4, fontSize: '0.75rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span className="font-mono">#{e.ingest_seq} - {e.type}</span>
                      <span className="font-mono">{new Date(e.event_ts).toLocaleTimeString()}</span>
                    </div>
                    {e.payload && (
                      <pre className="font-mono" style={{ color: 'var(--text-secondary)', marginTop: 2 }}>
                        {JSON.stringify(e.payload)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
