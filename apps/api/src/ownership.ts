import type { Pool, PoolClient } from 'pg';

export class OwnershipError extends Error {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';
  constructor() { super('Resource not found'); }
}

/** Call inside the mutation transaction when locking an owned project. */
export async function requireProjectOwner(db: Pool | PoolClient, projectId: string, actorId: string, lock = false) {
  const found = await db.query(`SELECT id FROM apcs_projects WHERE id=$1 AND owner_id=$2${lock ? ' FOR UPDATE' : ''}`, [projectId, actorId]);
  if (!found.rowCount) throw new OwnershipError();
}
