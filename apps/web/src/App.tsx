import React, { useState } from 'react';
import { Header } from './components/Header.js';
import { OverviewView } from './views/OverviewView.js';
import { DevicesView } from './views/DevicesView.js';
import { LiveEventsView } from './views/LiveEventsView.js';
import { IncidentsView } from './views/IncidentsView.js';
import { RulesView } from './views/RulesView.js';
import { SystemView } from './views/SystemView.js';
import { useLiveStream } from './useLiveStream.js';

export const App: React.FC = () => {
  const [currentTab, setCurrentTab] = useState('overview');
  const {
    state: streamState,
    lastLiveAt,
    liveEvents,
    isPaused,
    setIsPaused,
    clearEvents,
    manualReconnect,
  } = useLiveStream();

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
        streamState={streamState}
        lastLiveAt={lastLiveAt}
        onManualReconnect={manualReconnect}
      />

      <main style={{ flex: 1 }}>
        {currentTab === 'overview' && <OverviewView />}
        {currentTab === 'devices' && <DevicesView />}
        {currentTab === 'events' && (
          <LiveEventsView
            liveEvents={liveEvents}
            isPaused={isPaused}
            onTogglePause={() => setIsPaused(!isPaused)}
            onClear={clearEvents}
          />
        )}
        {currentTab === 'incidents' && <IncidentsView streamState={streamState} />}
        {currentTab === 'rules' && <RulesView />}
        {currentTab === 'system' && <SystemView />}
      </main>
    </div>
  );
};
