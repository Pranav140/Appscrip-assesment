import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';

export const DevicesView: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedDevice, setSelectedDevice] = useState<any | null>(null);

  const { data: devicesData, isLoading } = useQuery({
    queryKey: ['devices', statusFilter],
    queryFn: () => api.getDevices({ status: statusFilter || undefined }),
    refetchInterval: 5000,
  });

  const { data: detailData } = useQuery({
    queryKey: ['device-detail', selectedDevice?.id],
    queryFn: () => api.getDevice(selectedDevice.id),
    enabled: !!selectedDevice,
    refetchInterval: 3000,
  });

  const devices = devicesData?.devices ?? [];
  const filtered = devices.filter((d: any) =>
    searchTerm ? d.id.toLowerCase().includes(searchTerm.toLowerCase()) || d.name.toLowerCase().includes(searchTerm.toLowerCase()) : true
  );

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Fleet Device Registry</h1>
        <div style={{ display: 'flex', gap: 12 }}>
          <input
            type="text"
            placeholder="Search device id or name..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-primary)',
              padding: '8px 14px',
              borderRadius: 8,
              fontSize: '0.875rem',
              width: 240,
            }}
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-primary)',
              padding: '8px 14px',
              borderRadius: 8,
              fontSize: '0.875rem',
            }}
          >
            <option value="">All Statuses</option>
            <option value="online">Online</option>
            <option value="stale">Stale</option>
            <option value="offline">Offline</option>
            <option value="unknown">Unknown</option>
          </select>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selectedDevice ? '1fr 400px' : '1fr', gap: 20 }}>
        {/* Device Table */}
        <div className="glass-panel" style={{ overflow: 'hidden' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Device ID</th>
                <th>Name</th>
                <th>Status</th>
                <th>Location</th>
                <th>Last Seen (Server)</th>
                <th>Open Incidents</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>
                    Loading devices...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>
                    No devices match filter criteria.
                  </td>
                </tr>
              ) : (
                filtered.map((d: any) => (
                  <tr
                    key={d.id}
                    onClick={() => setSelectedDevice(d)}
                    style={{
                      cursor: 'pointer',
                      background: selectedDevice?.id === d.id ? 'rgba(6, 182, 212, 0.08)' : undefined,
                    }}
                  >
                    <td className="font-mono" style={{ fontWeight: 600 }}>{d.id}</td>
                    <td>{d.name}</td>
                    <td>
                      <span className={`status-pill status-${d.status}`}>{d.status}</span>
                    </td>
                    <td>{d.location_name ?? '—'}</td>
                    <td className="font-mono" style={{ color: 'var(--text-muted)' }}>
                      {d.last_seen_at ? new Date(d.last_seen_at).toLocaleTimeString() : 'Never'}
                    </td>
                    <td>
                      {d.open_incidents_count > 0 ? (
                        <span style={{ color: 'var(--accent-red)', fontWeight: 700 }}>
                          {d.open_incidents_count} active
                        </span>
                      ) : (
                        <span style={{ color: 'var(--accent-green)' }}>0</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Selected Device Drawer */}
        {selectedDevice && (
          <div className="glass-panel" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 700 }}>{selectedDevice.id} Details</h2>
              <button
                className="btn-secondary"
                style={{ padding: '2px 8px', fontSize: '0.75rem' }}
                onClick={() => setSelectedDevice(null)}
              >
                ✕ Close
              </button>
            </div>

            <div style={{ fontSize: '0.85rem', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div><strong>Name:</strong> {selectedDevice.name}</div>
              <div><strong>Status:</strong> <span className={`status-pill status-${selectedDevice.status}`}>{selectedDevice.status}</span></div>
              <div><strong>Location:</strong> {selectedDevice.location_name ?? 'Unassigned'}</div>
              <div><strong>Last Seen:</strong> {selectedDevice.last_seen_at ? new Date(selectedDevice.last_seen_at).toLocaleString() : 'Never'}</div>
              <div><strong>Device Clock:</strong> {selectedDevice.last_event_ts ? new Date(selectedDevice.last_event_ts).toLocaleString() : 'Never'}</div>
            </div>

            <hr style={{ borderColor: 'var(--border-subtle)' }} />

            <div>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 8 }}>Recent Events ({detailData?.recent_events?.length ?? 0})</h3>
              <div style={{ maxHeight: 250, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {detailData?.recent_events?.map((e: any) => (
                  <div key={e.ingest_seq} style={{ padding: '6px 8px', background: 'rgba(255,255,255,0.02)', borderRadius: 4, fontSize: '0.75rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span className="font-mono" style={{ color: 'var(--accent-cyan)' }}>{e.type}</span>
                      <span className="font-mono" style={{ color: 'var(--text-muted)' }}>{new Date(e.event_ts).toLocaleTimeString()}</span>
                    </div>
                    {e.payload && (
                      <pre className="font-mono" style={{ color: 'var(--text-secondary)', marginTop: 2, fontSize: '0.7rem' }}>
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
