/** Serial refresh loop; the caller handles refresh errors and aborts pending work. */
export function startPolling(refresh: () => Promise<void>, periodMs: number) {
  const origin = performance.now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
    await refresh();
    if (!stopped) {
      // Skip elapsed slots; response time is part of the period, not added to it.
      const now = performance.now();
      const next = origin + (Math.floor((now - origin) / periodMs) + 1) * periodMs;
      timer = setTimeout(() => { void poll(); }, Math.ceil(next - now));
    }
  }
  void poll();
  return () => { stopped = true; clearTimeout(timer); };
}
