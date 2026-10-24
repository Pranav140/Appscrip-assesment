const OPERATOR_TOKEN =
  (import.meta as unknown as { env: Record<string, string> }).env?.VITE_OPERATOR_TOKEN ??
  'rtops_operator_secret_token_123';

export class ApiError extends Error {
  public statusCode: number;
  public code: string;
  public details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${OPERATOR_TOKEN}`);
  headers.set('X-Operator-Id', 'operator-admin');

  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(endpoint, {
    ...options,
    headers,
  });

  if (!res.ok) {
    let errCode = 'UNKNOWN_ERROR';
    let errMsg = `Request failed with status ${res.status}`;
    let details: unknown = undefined;

    try {
      const data = await res.json();
      if (data?.error) {
        errCode = data.error.code ?? errCode;
        errMsg = data.error.message ?? errMsg;
        details = data.error.details;
      }
    } catch {
      // not JSON
    }

    throw new ApiError(res.status, errCode, errMsg, details);
  }

  return res.json() as Promise<T>;
}

export const api = {
  getStats: () => request<any>('/api/stats'),
  getDevices: (params?: { status?: string; location_id?: string; q?: string }) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return request<{ devices: any[] }>(`/api/devices${qs ? `?${qs}` : ''}`);
  },
  getDevice: (id: string) => request<any>(`/api/devices/${id}`),
  getEvents: (params?: { device_id?: string; type?: string; after_seq?: number; limit?: number }) => {
    const qs = new URLSearchParams(params as unknown as Record<string, string>).toString();
    return request<{ events: any[]; next_cursor: number | null }>(`/api/events${qs ? `?${qs}` : ''}`);
  },
  getFailedEvents: () => request<{ failed_events: any[] }>('/api/events/failed'),
  retryEvent: (seq: number) => request<any>(`/api/events/${seq}/retry`, { method: 'POST' }),
  getRejectedEvents: () => request<{ rejected_events: any[] }>('/api/rejected-events'),
  getIncidents: (params?: { state?: string; severity?: string; device_id?: string; cursor?: number }) => {
    const qs = new URLSearchParams(params as unknown as Record<string, string>).toString();
    return request<{ incidents: any[]; next_cursor: number | null }>(`/api/incidents${qs ? `?${qs}` : ''}`);
  },
  getIncident: (id: number) => request<any>(`/api/incidents/${id}`),
  acknowledgeIncident: (id: number, note?: string) =>
    request<any>(`/api/incidents/${id}/acknowledge`, {
      method: 'POST',
      body: JSON.stringify({ by: 'Alice Chen (Lead)', note }),
    }),
  resolveIncident: (id: number, reason?: string) =>
    request<any>(`/api/incidents/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ by: 'Alice Chen (Lead)', reason }),
    }),
  getRules: () => request<{ rules: any[] }>('/api/rules'),
  toggleRule: (id: number, enabled: boolean) =>
    request<any>(`/api/rules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  createRule: (rule: any) =>
    request<any>('/api/rules', {
      method: 'POST',
      body: JSON.stringify(rule),
    }),
  dryRunRule: (rule: any, sample_event: any) =>
    request<any>('/api/rules/dry-run', {
      method: 'POST',
      body: JSON.stringify({ rule, sample_event }),
    }),
  getNotifications: (status?: string) =>
    request<{ notifications: any[] }>(`/api/notifications${status ? `?status=${status}` : ''}`),
  retryNotification: (id: number) =>
    request<any>(`/api/notifications/${id}/retry`, { method: 'POST' }),
  getActivity: (limit = 30) => request<{ activity: any[] }>(`/api/activity?limit=${limit}`),
  getLocations: () => request<{ locations: any[] }>('/api/locations'),
};
