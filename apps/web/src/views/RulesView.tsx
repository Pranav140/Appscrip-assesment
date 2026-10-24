import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';

export const RulesView: React.FC = () => {
  const queryClient = useQueryClient();
  const [testResult, setTestResult] = useState<any | null>(null);
  const [selectedRuleForTest, setSelectedRuleForTest] = useState<any | null>(null);
  const [sampleEventJson, setSampleEventJson] = useState(`{
  "type": "telemetry",
  "payload": {
    "temperature": 88.5,
    "battery": 12
  }
}`);

  const { data: rulesData, isLoading } = useQuery({
    queryKey: ['rules'],
    queryFn: () => api.getRules(),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => api.toggleRule(id, enabled),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rules'] });
    },
  });

  const dryRunMutation = useMutation({
    mutationFn: async () => {
      if (!selectedRuleForTest) return;
      const sample = JSON.parse(sampleEventJson);
      return api.dryRunRule(selectedRuleForTest, sample);
    },
    onSuccess: (data) => {
      setTestResult(data);
    },
    onError: (err) => {
      setTestResult({ error: String(err) });
    },
  });

  const rules = rulesData?.rules ?? [];

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Rules Engine Configuration</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
          Define conditions that trigger incident creation. Changes trigger instant cache invalidation via Postgres NOTIFY.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 450px', gap: 20 }}>
        {/* Rules Table */}
        <div className="glass-panel" style={{ overflow: 'hidden' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Type</th>
                <th>Severity</th>
                <th>Scope</th>
                <th>Cooldown</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>
                    Loading rules...
                  </td>
                </tr>
              ) : rules.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
                    No rules found.
                  </td>
                </tr>
              ) : (
                rules.map((r: any) => (
                  <tr
                    key={r.id}
                    onClick={() => setSelectedRuleForTest(r)}
                    style={{
                      cursor: 'pointer',
                      background: selectedRuleForTest?.id === r.id ? 'rgba(6, 182, 212, 0.08)' : undefined,
                    }}
                  >
                    <td className="font-mono">#{r.id}</td>
                    <td style={{ fontWeight: 600 }}>{r.name}</td>
                    <td>
                      <span className="font-mono" style={{ fontSize: '0.8rem', color: 'var(--accent-cyan)' }}>
                        {r.type}
                      </span>
                    </td>
                    <td>
                      <span
                        style={{
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          color:
                            r.severity === 'critical'
                              ? 'var(--accent-red)'
                              : r.severity === 'high'
                              ? 'var(--accent-amber)'
                              : 'var(--accent-cyan)',
                        }}
                      >
                        {r.severity}
                      </span>
                    </td>
                    <td>{r.scope}</td>
                    <td>{r.cooldown_seconds}s</td>
                    <td>
                      <span
                        style={{
                          color: r.enabled ? 'var(--accent-green)' : 'var(--text-muted)',
                          fontWeight: 600,
                          fontSize: '0.85rem',
                        }}
                      >
                        {r.enabled ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        className="btn-secondary"
                        style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                        onClick={() => toggleMutation.mutate({ id: r.id, enabled: !r.enabled })}
                      >
                        {r.enabled ? 'Disable' : 'Enable'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Dry Run Test Panel */}
        <div className="glass-panel" style={{ padding: 20 }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 8 }}>Dry-Run Simulator</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 16 }}>
            Test rule evaluation against sample telemetry without writing to database or creating incidents.
          </p>

          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
              Selected Rule:
            </label>
            <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>
              {selectedRuleForTest ? `${selectedRuleForTest.name} (${selectedRuleForTest.type})` : 'Select a rule from the table'}
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
              Sample Event JSON:
            </label>
            <textarea
              value={sampleEventJson}
              onChange={(e) => setSampleEventJson(e.target.value)}
              rows={8}
              className="font-mono"
              style={{
                width: '100%',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-primary)',
                padding: 10,
                borderRadius: 8,
                fontSize: '0.8rem',
              }}
            />
          </div>

          <button
            className="btn-primary"
            style={{ width: '100%', justifyContent: 'center' }}
            disabled={!selectedRuleForTest}
            onClick={() => dryRunMutation.mutate()}
          >
            Run Dry-Run Evaluation
          </button>

          {testResult && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                borderRadius: 8,
                background: testResult.matched ? 'rgba(16, 185, 129, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                border: `1px solid ${testResult.matched ? 'var(--accent-green)' : 'var(--border-subtle)'}`,
              }}
            >
              <div style={{ fontWeight: 700, fontSize: '0.9rem', color: testResult.matched ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                {testResult.matched ? 'MATCHED' : 'NO MATCH'}
              </div>
              <div style={{ fontSize: '0.85rem', marginTop: 4 }}>
                <strong>Reason:</strong> {testResult.reason ?? testResult.error}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
