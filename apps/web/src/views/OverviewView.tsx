import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';

export const OverviewView: React.FC = () => {
  const { data: stats } = useQuery({
    queryKey: ['stats'],
    queryFn: () => api.getStats(),
    refetchInterval: 5000,
  });

  const { data: activityData } = useQuery({
    queryKey: ['activity'],
    queryFn: () => api.getActivity(15),
    refetchInterval: 5000,
  });

  const devStatus = stats?.devices_by_status ?? {};
  const incState = stats?.incidents_by_state ?? {};
  const incSev = stats?.incidents_by_severity ?? {};

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 20 }}>Operations Fleet Overview</h1>

      {/* Primary KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 24 }}>
        <div className="glass-panel" style={{ padding: 20 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>Fleet Status</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, marginTop: 4, color: 'var(--accent-green)' }}>
            {devStatus['online'] ?? 0}{' '}
            <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', fontWeight: 500 }}>online</span>
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>
            {devStatus['stale'] ?? 0} stale · {devStatus['offline'] ?? 0} offline
          </div>
        </div>

        <div className="glass-panel" style={{ padding: 20 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>Active Incidents</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, marginTop: 4, color: (incState['open'] ?? 0) > 0 ? 'var(--accent-red)' : 'var(--text-primary)' }}>
            {(incState['open'] ?? 0) + (incState['acknowledged'] ?? 0)}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>
            {incSev['critical'] ?? 0} critical · {incSev['high'] ?? 0} high
          </div>
        </div>

        <div className="glass-panel" style={{ padding: 20 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>Queue Depth</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, marginTop: 4, color: 'var(--accent-cyan)' }}>
            {stats?.queue_depth ?? 0}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>
            Pending in Postgres durable buffer
          </div>
        </div>

        <div className="glass-panel" style={{ padding: 20 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>Processing Lag (p95)</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, marginTop: 4, color: 'var(--accent-purple)' }}>
            {stats?.processing_lag_p95_sec ? `${stats.processing_lag_p95_sec.toFixed(2)}s` : '< 0.05s'}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>
            p50: {stats?.processing_lag_p50_sec ? `${stats.processing_lag_p50_sec.toFixed(2)}s` : '< 0.01s'}
          </div>
        </div>

        <div className="glass-panel" style={{ padding: 20 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>Failed / Dead Letters</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, marginTop: 4, color: (stats?.failed_events_count ?? 0) > 0 ? 'var(--accent-red)' : 'var(--text-secondary)' }}>
            {stats?.failed_events_count ?? 0}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>
            Dead-lettered events requiring operator action
          </div>
        </div>
      </div>

      {/* Grid: Events per minute & Activity Feed */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* Ingest Trend */}
        <div className="glass-panel" style={{ padding: 20 }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: 16 }}>Ingestion Activity (Last 15 Min)</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {stats?.events_per_minute_buckets && stats.events_per_minute_buckets.length > 0 ? (
              stats.events_per_minute_buckets.map((b: any) => (
                <div key={b.minute} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span className="font-mono" style={{ fontSize: '0.8rem', color: 'var(--text-muted)', width: 60 }}>
                    {new Date(b.minute).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <div style={{ flex: 1, background: 'rgba(255,255,255,0.05)', borderRadius: 4, height: 16, overflow: 'hidden' }}>
                    <div
                      style={{
                        background: 'linear-gradient(90deg, #06b6d4, #3b82f6)',
                        height: '100%',
                        width: `${Math.min(100, Math.max(8, (b.count / 50) * 100))}%`,
                        transition: 'width 0.3s ease',
                      }}
                    />
                  </div>
                  <span className="font-mono" style={{ fontSize: '0.8rem', width: 45, textAlign: 'right' }}>
                    {b.count}
                  </span>
                </div>
              ))
            ) : (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No recent events recorded.</div>
            )}
          </div>
        </div>

        {/* Real-Time Activity Log */}
        <div className="glass-panel" style={{ padding: 20 }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: 16 }}>Live Operational Audit Feed</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 380, overflowY: 'auto' }}>
            {activityData?.activity && activityData.activity.length > 0 ? (
              activityData.activity.map((a: any) => (
                <div
                  key={a.id}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 6,
                    background: 'rgba(255,255,255,0.02)',
                    borderLeft: `3px solid ${
                      a.kind.includes('created')
                        ? 'var(--accent-red)'
                        : a.kind.includes('resolved')
                        ? 'var(--accent-green)'
                        : 'var(--accent-cyan)'
                    }`,
                    fontSize: '0.85rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                    <span style={{ fontWeight: 600, textTransform: 'uppercase' }}>{a.kind}</span>
                    <span className="font-mono">{new Date(a.created_at).toLocaleTimeString()}</span>
                  </div>
                  <div style={{ marginTop: 4, color: 'var(--text-primary)' }}>
                    Entity: <span className="font-mono">{a.entity_type}/{a.entity_id}</span>
                  </div>
                </div>
              ))
            ) : (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No recent activity.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
