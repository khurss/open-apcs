import type { SignalObservation, SignalSnapshot } from './signals.js';
export interface HistoryRow extends SignalObservation { eventId: string; }
export interface ArchivedSample { id: string; observedAt: string; snapshot: SignalSnapshot; }
export interface HistoryPage { items: ArchivedSample[]; nextBefore: string | null; }
export interface HistoryQuery { from: string; to: string; before?: string; limit?: number; }
