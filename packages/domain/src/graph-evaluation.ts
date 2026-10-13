import type { BlockKind, LogicResult } from './logic.js';
/** Observational snapshot of one activated revision, never an actuator acknowledgement. */
export interface GraphEvaluation {
  at: string;
  cycle: number;
  blocks: { id: string; label: string; kind: BlockKind }[];
  result: LogicResult;
}
