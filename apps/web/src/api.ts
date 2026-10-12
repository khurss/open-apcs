export interface User { id: string; username: string; csrfToken: string; }
export interface Project { id: string; name: string; revision: number; }
export interface Device { id: string; name: string; projectId: string; siteId: string; deviceId: string; kind: 'virtual-led' | 'esp32-led'; }
export interface Signal { id: string; deviceId: string; name: string; dataType: string; direction: string; }
export interface Sample { value: boolean | null; quality: string; receivedTime: string | null; }
export interface Audit { id: string; action: string; at: string; resourceId: string | null; }
export interface Page<T> { items: T[]; nextCursor: string | null; }
export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
let csrfToken = '';
export const setSession = (user: User | null) => { csrfToken = user?.csrfToken ?? ''; };
export async function api<T>(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: options.method ?? 'GET', credentials: 'same-origin',
    ...(options.signal ? { signal: options.signal } : {}),
    headers: { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.method ? { 'X-CSRF-Token': csrfToken } : {}), ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (response.status === 204) return undefined as T;
  const data: unknown = await response.json();
  if (!response.ok) {
    const message = typeof data === 'object' && data !== null && 'message' in data && typeof data.message === 'string'
      ? data.message : 'The request could not be completed';
    throw new ApiError(response.status, message);
  }
  return data as T;
}
