import { assessConsensus } from './consensus.mjs';

export const GOALS = ['explore', 'decide', 'audit'];

// Evidence entries are reported references. Their presence never verifies a claim.
export function assessOutcome(statuses, context) {
  const consensus = assessConsensus(statuses, context);
  if (context.round < context.minRounds) return { complete: false, consensus: false, reason: consensus.reason };
  const current = new Map(statuses.map(status => [status.agent, status]));
  if (context.expectedAgents.some(id => !current.get(id)?.parsed)) {
    return { complete: false, consensus: false, reason: 'missing or invalid participant status' };
  }
  if (context.goal === 'explore' && consensus.converged && statuses.every(s => s.outcome === undefined)) {
    return { complete: true, consensus: true, reason: consensus.reason };
  }
  if (!statuses.every(s => s.outcome === 'complete')) {
    return { complete: false, consensus: false, reason: 'participants still developing the outcome' };
  }
  if (!statuses.every(s => s.claims?.length)) {
    return { complete: false, consensus: false, reason: 'completion needs explicit claims or alternatives' };
  }
  if (context.goal !== 'explore') {
    const incomplete = statuses.flatMap(s => s.claims).some(claim =>
      (['supported', 'refuted'].includes(claim.status) && !claim.evidence.length) ||
      (['unverified', 'disputed'].includes(claim.status) && !claim.next_step?.trim()));
    if (incomplete) return { complete: false, consensus: false, reason: 'claims need evidence references or a bounded verification step' };
  }
  return { complete: true, consensus: consensus.converged,
    reason: consensus.converged ? 'outcome ready with reported agreement' : 'outcome ready with disagreement preserved' };
}
