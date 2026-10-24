import React from 'react';
import type { StreamState } from '../useLiveStream.js';

interface HeaderProps {
  currentTab: string;
  onSelectTab: (tab: string) => void;
  streamState: StreamState;
  lastLiveAt: Date | null;
  onManualReconnect: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentTab,
  onSelectTab,
  streamState,
  lastLiveAt,
  onManualReconnect,
}) => {
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'devices', label: 'Fleet Devices' },
    { id: 'events', label: 'Live Events' },
    { id: 'incidents', label: 'Incidents' },
    { id: 'rules', label: 'Rules' },
    { id: 'system', label: 'System & DLQ' },
  ];

  return (
    <>
      <header className="app-header">
        <div className="brand-badge">
          <div className="brand-dot" />
          <span>RTOps <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>| Operations Platform</span></span>
        </div>

        <nav className="nav-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`nav-tab-btn ${currentTab === tab.id ? 'active' : ''}`}
              onClick={() => onSelectTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {streamState === 'live' && (
            <span className="status-pill status-online">
              ● Live Stream
            </span>
          )}
          {streamState === 'reconnecting' && (
            <span className="status-pill status-stale">
              ◌ Reconnecting...
            </span>
          )}
          {streamState === 'offline' && (
            <span className="status-pill status-offline">
              ✕ Offline
            </span>
          )}
        </div>
      </header>

      {streamState !== 'live' && (
        <div className="connection-banner">
          <div>
            ⚠️ Connection to server lost. Displaying cached state from{' '}
            {lastLiveAt ? lastLiveAt.toLocaleTimeString() : 'earlier'}.{' '}
            {streamState === 'reconnecting' ? 'Attempting automatic reconnection...' : 'Network is offline.'}
          </div>
          <button
            className="btn-secondary"
            style={{ padding: '4px 12px', fontSize: '0.8rem', background: 'rgba(0,0,0,0.3)' }}
            onClick={onManualReconnect}
          >
            Reconnect Now
          </button>
        </div>
      )}
    </>
  );
};
