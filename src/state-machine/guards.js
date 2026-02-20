import { createLogger } from '../utils/logger.js';
import { parseThreshold, parsePositiveInt } from '../utils/env.js';

const log = createLogger('state-machine-guards');

// ─── Environment-driven thresholds (with safe defaults) ─────

const MAX_REFLECTION_LOOPS = parsePositiveInt('VIGIL_MAX_REFLECTION_LOOPS', 3);
const SUPPRESS_THRESHOLD   = parseThreshold('VIGIL_TRIAGE_SUPPRESS_THRESHOLD', 0.4);

// ─── Individual guard functions ─────────────────────────────
// Each returns { allowed: boolean, redirectTo: string|null, reason: string }

export function reflectionLimitGuard(doc, _ctx) {
  const count = doc.reflection_count || 0;
  if (count >= MAX_REFLECTION_LOOPS) {
    log.warn(`Reflection limit reached (${count}/${MAX_REFLECTION_LOOPS})`);
    return {
      allowed: false,
      redirectTo: 'escalated',
      reason: `reflection limit reached (${count}/${MAX_REFLECTION_LOOPS})`
    };
  }
  return { allowed: true, redirectTo: null, reason: 'reflection count within limit' };
}

export function approvalRequiredGuard(_doc, ctx) {
  if (!ctx || !ctx.remediationPlan) {
    return { allowed: false, redirectTo: null, reason: 'missing required context: remediationPlan' };
  }
  if (!Array.isArray(ctx.remediationPlan.actions)) {
    return { allowed: false, redirectTo: null, reason: 'remediationPlan.actions is not an array' };
  }
  const needsApproval = ctx.remediationPlan.actions.some(a => a.approval_required);
  if (needsApproval) {
    return { allowed: true, redirectTo: null, reason: 'actions require approval' };
  }
  return { allowed: false, redirectTo: null, reason: 'no actions require approval' };
}

export function approvalNotRequiredGuard(_doc, ctx) {
  if (!ctx || !ctx.remediationPlan) {
    return { allowed: false, redirectTo: null, reason: 'missing required context: remediationPlan' };
  }
  if (!Array.isArray(ctx.remediationPlan.actions)) {
    return { allowed: false, redirectTo: null, reason: 'remediationPlan.actions is not an array' };
  }
  const needsApproval = ctx.remediationPlan.actions.some(a => a.approval_required);
  if (!needsApproval) {
    return { allowed: true, redirectTo: null, reason: 'no actions require approval' };
  }
  return { allowed: false, redirectTo: null, reason: 'actions require approval' };
}

export function approvalGrantedGuard(_doc, ctx) {
  if (!ctx || ctx.approvalStatus === undefined) {
    return { allowed: false, redirectTo: null, reason: 'missing required context: approvalStatus' };
  }
  if (ctx.approvalStatus === 'approved') {
    return { allowed: true, redirectTo: null, reason: 'approval granted' };
  }
  return { allowed: false, redirectTo: null, reason: `approval not granted (status: ${ctx.approvalStatus})` };
}

export function approvalDeniedGuard(_doc, ctx) {
  if (!ctx || ctx.approvalStatus === undefined) {
    return { allowed: false, redirectTo: null, reason: 'missing required context: approvalStatus' };
  }
  if (ctx.approvalStatus === 'rejected' || ctx.approvalStatus === 'timeout') {
    return { allowed: true, redirectTo: null, reason: `approval denied (status: ${ctx.approvalStatus})` };
  }
  return { allowed: false, redirectTo: null, reason: `approval not denied (status: ${ctx.approvalStatus})` };
}

export function suppressThresholdGuard(doc, _ctx) {
  if (doc.priority_score == null || Number.isNaN(doc.priority_score)) {
    return { allowed: false, redirectTo: null, reason: 'priority_score is missing or invalid' };
  }
  if (doc.priority_score < SUPPRESS_THRESHOLD) {
    return { allowed: true, redirectTo: null, reason: `priority score ${doc.priority_score} below threshold ${SUPPRESS_THRESHOLD}` };
  }
  return { allowed: false, redirectTo: null, reason: `priority score ${doc.priority_score} >= threshold ${SUPPRESS_THRESHOLD}` };
}

export function investigateThresholdGuard(doc, _ctx) {
  if (doc.priority_score == null || Number.isNaN(doc.priority_score)) {
    return { allowed: false, redirectTo: null, reason: 'priority_score is missing or invalid' };
  }
  if (doc.priority_score >= SUPPRESS_THRESHOLD) {
    return { allowed: true, redirectTo: null, reason: `priority score ${doc.priority_score} meets threshold ${SUPPRESS_THRESHOLD}` };
  }
  return { allowed: false, redirectTo: null, reason: `priority score ${doc.priority_score} below threshold ${SUPPRESS_THRESHOLD}` };
}

export function verifierPassedGuard(_doc, ctx) {
  if (!ctx || !ctx.verifierResponse) {
    return { allowed: false, redirectTo: null, reason: 'missing required context: verifierResponse' };
  }
  if (ctx.verifierResponse.passed === true) {
    return { allowed: true, redirectTo: null, reason: 'verifier passed' };
  }
  return { allowed: false, redirectTo: null, reason: 'verifier did not pass' };
}

export function verifierFailedGuard(_doc, ctx) {
  if (!ctx || !ctx.verifierResponse) {
    return { allowed: false, redirectTo: null, reason: 'missing required context: verifierResponse' };
  }
  if (ctx.verifierResponse.passed === false) {
    return { allowed: true, redirectTo: null, reason: 'verifier failed' };
  }
  return { allowed: false, redirectTo: null, reason: 'verifier did not fail' };
}

// ─── Reflection auto-escalation guard ────────────────────────

export function reflectionAutoEscalateGuard(doc, _ctx) {
  const count = doc.reflection_count || 0;
  if (count >= MAX_REFLECTION_LOOPS) {
    return { allowed: true, redirectTo: null, reason: `reflection limit reached (${count}/${MAX_REFLECTION_LOOPS})` };
  }
  return { allowed: false, redirectTo: null, reason: `reflection count ${count} within limit ${MAX_REFLECTION_LOOPS}` };
}

// ─── Composed guard: verifying -> reflecting ────────────────
// Checks verifier failed first, then reflection limit.

function verifyingToReflectingGuard(doc, ctx) {
  const vf = verifierFailedGuard(doc, ctx);
  if (!vf.allowed) return vf;
  return reflectionLimitGuard(doc, ctx);
}

// ─── Guard Registry ─────────────────────────────────────────

export const GUARD_REGISTRY = new Map([
  ['verifying->reflecting',        verifyingToReflectingGuard],
  ['verifying->resolved',          verifierPassedGuard],
  ['planning->awaiting_approval',  approvalRequiredGuard],
  ['planning->executing',          approvalNotRequiredGuard],
  ['awaiting_approval->executing', approvalGrantedGuard],
  ['awaiting_approval->escalated', approvalDeniedGuard],
  ['triaged->suppressed',          suppressThresholdGuard],
  ['triaged->investigating',       investigateThresholdGuard],
  ['reflecting->escalated',        reflectionAutoEscalateGuard],
]);

// ─── Main entry point ───────────────────────────────────────

export function evaluateGuard(incidentDoc, from, to, context = {}) {
  if (incidentDoc == null || typeof incidentDoc !== 'object') {
    throw new TypeError('incidentDoc is required and must be an object');
  }
  const key = `${from}->${to}`;
  const guardFn = GUARD_REGISTRY.get(key);
  if (!guardFn) {
    return { allowed: true, redirectTo: null, reason: 'no guard registered' };
  }
  return guardFn(incidentDoc, context);
}
