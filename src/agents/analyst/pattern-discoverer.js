import { v4 as uuidv4 } from 'uuid';
import client from '../../utils/elastic-client.js';
import { createLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import { embedSafe } from '../../utils/embed-helpers.js';
import { parseDuration } from '../../utils/duration.js';
import {
  MIN_CLUSTER_SIZE, JACCARD_THRESHOLD,
  PATTERN_SEARCH_SIZE, MAX_CLUSTER_SIZE
} from './constants.js';

const log = createLogger('analyst:pattern-discoverer');

/**
 * Compute Jaccard similarity between two sets.
 * J(A,B) = |A ∩ B| / |A ∪ B|
 *
 * Returns 0 for empty sets by design — incidents with no techniques are filtered before clustering.
 *
 * @param {Set} setA
 * @param {Set} setB
 * @returns {number} Jaccard similarity [0.0, 1.0]
 */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Extract MITRE technique IDs from an incident.
 * Handles various field locations where techniques might be stored.
 *
 * @param {object} incident - Incident result object
 * @returns {Set<string>} Set of technique IDs
 */
function extractTechniques(incident) {
  const techniques = new Set();

  // Direct mitre_techniques field
  const mitreTechniques = incident.mitre_techniques;
  if (Array.isArray(mitreTechniques)) {
    for (const t of mitreTechniques) {
      if (typeof t === 'string') techniques.add(t);
      else if (t?.technique_id) techniques.add(t.technique_id);
    }
  }

  // Attack chain field
  const attackChain = incident.attack_chain;
  if (Array.isArray(attackChain)) {
    for (const step of attackChain) {
      if (typeof step === 'string') techniques.add(step);
      else if (step?.technique_id) techniques.add(step.technique_id);
    }
  }

  return techniques;
}

/**
 * Cluster incidents by behavioral similarity using pairwise Jaccard
 * on MITRE technique sets.
 *
 * Uses average-linkage clustering: an incident joins a cluster if its
 * average Jaccard similarity across ALL cluster members >= JACCARD_THRESHOLD.
 *
 * O(n^2) pairwise comparisons. PATTERN_SEARCH_SIZE caps n (default 50).
 * MAX_CLUSTER_SIZE prevents single-cluster dominance.
 *
 * @param {Array<object>} incidents - Incident objects with technique sets
 * @returns {Array<Array<object>>} Clusters of similar incidents
 */
function clusterByTechniques(incidents) {
  // Pre-compute technique sets
  const enriched = incidents.map(inc => ({
    ...inc,
    _techniques: extractTechniques(inc)
  })).filter(inc => inc._techniques.size > 0);

  if (enriched.length < MIN_CLUSTER_SIZE) return [];

  // Average-linkage clustering
  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < enriched.length; i++) {
    if (assigned.has(i)) continue;

    const cluster = [enriched[i]];
    assigned.add(i);

    // Grow the cluster
    let changed = true;
    while (changed) {
      changed = false;
      if (cluster.length >= MAX_CLUSTER_SIZE) break;

      for (let j = 0; j < enriched.length; j++) {
        if (assigned.has(j)) continue;
        if (cluster.length >= MAX_CLUSTER_SIZE) break;

        // Average-linkage: compute mean similarity across ALL cluster members
        const avgSimilarity = cluster.reduce(
          (sum, member) => sum + jaccardSimilarity(member._techniques, enriched[j]._techniques), 0
        ) / cluster.length;

        if (avgSimilarity >= JACCARD_THRESHOLD) {
          cluster.push(enriched[j]);
          assigned.add(j);
          changed = true;
        }
      }
    }

    if (cluster.length >= MIN_CLUSTER_SIZE) {
      clusters.push(cluster);
    }
  }

  return clusters;
}

/**
 * MITRE ATT&CK kill-chain tactic ordering for consistent pattern naming.
 */
const TACTIC_ORDER = [
  'reconnaissance', 'resource-development', 'initial-access', 'execution',
  'persistence', 'privilege-escalation', 'defense-evasion', 'credential-access',
  'discovery', 'lateral-movement', 'collection', 'command-and-control',
  'exfiltration', 'impact'
];

/**
 * Derive a pattern name from common techniques in a cluster.
 * Sorts by MITRE kill-chain tactic order for consistent naming.
 *
 * @param {Array<object>} cluster - Cluster members
 * @returns {string} Human-readable pattern name
 */
function derivePatternName(cluster) {
  // Collect technique-to-tactic mappings from attack chains
  const techTactics = {};
  const techniqueCounts = {};
  for (const inc of cluster) {
    for (const t of inc._techniques) {
      techniqueCounts[t] = (techniqueCounts[t] || 0) + 1;
    }
    if (Array.isArray(inc.attack_chain)) {
      for (const step of inc.attack_chain) {
        const techId = typeof step === 'string' ? step : step?.technique_id;
        const tactic = step?.tactic;
        if (techId && tactic) techTactics[techId] = tactic;
      }
    }
  }

  // Get techniques present in majority of incidents, sorted by tactic order
  const commonTechniques = Object.entries(techniqueCounts)
    .filter(([, count]) => count >= cluster.length * 0.5)
    .map(([tech]) => tech)
    .sort((a, b) => {
      const orderA = TACTIC_ORDER.indexOf((techTactics[a] || '').toLowerCase());
      const orderB = TACTIC_ORDER.indexOf((techTactics[b] || '').toLowerCase());
      return (orderA === -1 ? 99 : orderA) - (orderB === -1 ? 99 : orderB);
    });

  if (commonTechniques.length >= 2) {
    return `${commonTechniques[0]} to ${commonTechniques[commonTechniques.length - 1]} Chain`;
  }
  if (commonTechniques.length === 1) {
    return `${commonTechniques[0]} Pattern`;
  }
  return 'Multi-Step Attack Pattern';
}

/**
 * Compute average pairwise Jaccard similarity within a cluster.
 *
 * @param {Array<object>} cluster - Cluster members with _techniques
 * @returns {number} Average pairwise similarity
 */
function computeClusterTightness(cluster) {
  let totalSimilarity = 0;
  let pairCount = 0;

  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      totalSimilarity += jaccardSimilarity(
        cluster[i]._techniques,
        cluster[j]._techniques
      );
      pairCount++;
    }
  }

  return pairCount > 0 ? totalSimilarity / pairCount : 0;
}

/**
 * Extract MITRE sequence with typical positions from a cluster.
 * Merges both attack_chain (has ordering) and mitre_techniques (fallback source).
 *
 * @param {Array<object>} cluster - Cluster members
 * @returns {Array<object>} Ordered technique sequence
 */
function extractMitreSequence(cluster) {
  const techniquePositions = {};

  for (const inc of cluster) {
    // Primary source: attack_chain (has ordering)
    const chain = inc.attack_chain;
    if (Array.isArray(chain)) {
      chain.forEach((step, position) => {
        const techId = typeof step === 'string' ? step : step?.technique_id;
        if (!techId) return;

        if (!techniquePositions[techId]) {
          techniquePositions[techId] = {
            technique_id: techId,
            technique_name: step?.technique_name || techId,
            tactic: step?.tactic || 'unknown',
            positions: []
          };
        }
        techniquePositions[techId].positions.push(position + 1);
      });
    }

    // Secondary source: mitre_techniques (no ordering info — assign position 0)
    const mitreTechniques = inc.mitre_techniques;
    if (Array.isArray(mitreTechniques)) {
      for (const t of mitreTechniques) {
        const techId = typeof t === 'string' ? t : t?.technique_id;
        if (!techId || techniquePositions[techId]) continue; // skip already seen
        techniquePositions[techId] = {
          technique_id: techId,
          technique_name: t?.technique_name || techId,
          tactic: t?.tactic || 'unknown',
          positions: [0]
        };
      }
    }
  }

  return Object.values(techniquePositions)
    .map(t => ({
      technique_id: t.technique_id,
      technique_name: t.technique_name,
      tactic: t.tactic,
      typical_position: median(t.positions)
    }))
    .sort((a, b) => a.typical_position - b.typical_position);
}

/**
 * Compute median of a numeric array.
 */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Extract timing information from a cluster of incidents.
 *
 * @param {Array<object>} cluster - Cluster members
 * @returns {object} Timing analysis
 */
function extractTiming(cluster) {
  const durations = cluster
    .map(inc => {
      if (!inc.created_at || !inc.resolved_at) return null;
      const created = new Date(inc.created_at);
      const resolved = new Date(inc.resolved_at);
      if (isNaN(created.getTime()) || isNaN(resolved.getTime())) return null;
      return (resolved - created) / 3600000; // hours
    })
    .filter(d => d !== null && d > 0);

  if (durations.length === 0) {
    return { total_duration_hours: 'unknown' };
  }

  durations.sort((a, b) => a - b);
  const min = Math.round(durations[0] * 10) / 10;
  const max = Math.round(durations[durations.length - 1] * 10) / 10;

  return {
    total_duration_hours: min === max ? String(min) : `${min}-${max}`
  };
}

/**
 * Collect common indicators across cluster incidents.
 *
 * @param {Array<object>} cluster - Cluster members
 * @returns {Array<string>} Common indicators
 */
function collectCommonIndicators(cluster) {
  const indicators = [];

  // Collect common services
  const services = {};
  for (const inc of cluster) {
    const svc = inc.affected_service;
    if (svc) services[svc] = (services[svc] || 0) + 1;
  }
  const commonServices = Object.entries(services)
    .filter(([, count]) => count >= 2)
    .map(([svc]) => svc);

  if (commonServices.length > 0) {
    indicators.push(`Commonly targeted services: ${commonServices.join(', ')}`);
  }

  // Collect common severity
  const severities = {};
  for (const inc of cluster) {
    if (inc.severity) severities[inc.severity] = (severities[inc.severity] || 0) + 1;
  }
  const commonSeverity = Object.entries(severities)
    .filter(([, count]) => count >= Math.ceil(cluster.length / 2))
    .map(([sev]) => sev);

  if (commonSeverity.length > 0) {
    indicators.push(`Typical severity: ${commonSeverity.join(', ')}`);
  }

  return indicators;
}

/**
 * Run attack pattern discovery across resolved security incidents.
 *
 * Searches for resolved security incidents, clusters by MITRE technique
 * similarity using Jaccard coefficient, and codifies recurring patterns.
 *
 * @param {object} options
 * @param {string} [options.window='90d'] - Lookback window
 * @returns {Promise<Array<object>>} Learning records written
 */
export async function runPatternDiscovery({ window = '90d' } = {}) {
  log.info(`Starting pattern discovery (window: ${window})`);

  let results;
  try {
    const searchResults = await client.search({
      index: 'vigil-incidents',
      query: {
        bool: {
          must: [
            { terms: { status: ['resolved', 'escalated'] } },
            { term: { incident_type: 'security' } }
          ],
          filter: [
            { range: { created_at: { gte: `now-${window}` } } }
          ]
        }
      },
      _source: [
        'incident_id', 'incident_type', 'severity', 'root_cause',
        'attack_chain', 'mitre_techniques', 'affected_service',
        'remediation_plan.actions', 'investigation_summary',
        'created_at', 'resolved_at', 'reflection_count'
      ],
      size: PATTERN_SEARCH_SIZE,
      timeout: '30s'
    });
    results = searchResults.hits.hits.map(h => h._source);
  } catch (err) {
    log.error(`Pattern discovery ES query failed: ${err.message}`);
    return [];
  }

  if (results.length >= PATTERN_SEARCH_SIZE * 0.9) {
    log.warn(`Pattern search returned ${results.length}/${PATTERN_SEARCH_SIZE} incidents — results may be truncated. Consider increasing ANALYST_PATTERN_SEARCH_SIZE.`);
  }

  if (!results || results.length < MIN_CLUSTER_SIZE) {
    log.info(
      `Insufficient incidents for pattern discovery: ${results?.length || 0} ` +
      `(need ${MIN_CLUSTER_SIZE}). Skipping.`
    );
    return [];
  }

  log.info(`Retrieved ${results.length} security incidents for pattern analysis`);

  // Cluster by technique similarity
  const allClusters = clusterByTechniques(results);

  // Quality gate: drop clusters with low internal tightness
  const clusters = allClusters.filter(cluster => {
    const tightness = computeClusterTightness(cluster);
    if (tightness < JACCARD_THRESHOLD) {
      log.info(`Dropping low-quality cluster (tightness ${(tightness * 100).toFixed(0)}% < ${JACCARD_THRESHOLD * 100}%)`);
      return false;
    }
    return true;
  });

  if (clusters.length === 0) {
    log.info('No qualifying patterns found (no clusters with 3+ incidents and >70% overlap)');
    return [];
  }

  log.info(`Discovered ${clusters.length} attack pattern(s)`);

  const learningRecords = [];
  const now = new Date().toISOString();

  for (const cluster of clusters) {
    const incidentIds = cluster.map(inc => inc.incident_id).filter(Boolean);

    // Dedup: check if a pattern with overlapping incident IDs already exists
    try {
      const existingPattern = await client.search({
        index: 'vigil-learnings',
        query: { bool: { must: [
          { term: { learning_type: 'pattern_discovery' } },
          { terms: { incident_ids: incidentIds } }
        ] } },
        size: 1,
        _source: ['learning_id', 'incident_ids'],
        timeout: '30s'
      });

      if (existingPattern.hits.hits.length > 0) {
        const overlap = existingPattern.hits.hits[0]._source.incident_ids || [];
        const overlapRatio = incidentIds.filter(id => overlap.includes(id)).length / incidentIds.length;
        if (overlapRatio >= 0.8) {
          log.info(`Pattern cluster overlaps ${(overlapRatio * 100).toFixed(0)}% with existing ${existingPattern.hits.hits[0]._source.learning_id} — skipping`);
          continue;
        }
      }
    } catch (dedupErr) {
      log.warn(`Pattern dedup check failed: ${dedupErr.message} — proceeding`);
    }

    const patternName = derivePatternName(cluster);
    const mitreSequence = extractMitreSequence(cluster);
    const timing = extractTiming(cluster);
    const commonIndicators = collectCommonIndicators(cluster);
    const stepOverlap = computeClusterTightness(cluster);

    const confidence = Math.min(0.95, Math.max(0.5, stepOverlap * 0.8 + (cluster.length / 10) * 0.2));

    const summary =
      `Identified recurring attack pattern: '${patternName}'. ` +
      `Observed in ${cluster.length} incidents over ${window} window ` +
      `with ${(stepOverlap * 100).toFixed(0)}% step overlap. ` +
      `MITRE sequence: ${mitreSequence.map(t => t.technique_id).join(' → ')}.`;

    const summaryVector = await embedSafe(summary, log, 'summary_vector');

    const patternId = `VPAT-${uuidv4().slice(0, 6).toUpperCase()}`;

    const learningRecord = {
      '@timestamp': now,
      learning_id: `LRN-PAT-${uuidv4().slice(0, 8).toUpperCase()}`,
      learning_type: 'pattern_discovery',
      incident_ids: incidentIds,
      analysis_window: {
        start: new Date(Date.now() - parseDuration(window, 90 * 24 * 60 * 60 * 1000)).toISOString(),
        end: now,
        incident_count: cluster.length
      },
      summary,
      confidence: Math.round(confidence * 100) / 100,
      data: {
        pattern_name: patternName,
        pattern_id: patternId,
        mitre_sequence: mitreSequence,
        typical_timing: timing,
        common_indicators: commonIndicators,
        step_overlap: Math.round(stepOverlap * 100) / 100,
        incidents_matched: cluster.length
      },
      applied: false,
      applied_at: null,
      reviewed_by: null,
      review_status: 'pending'
    };

    if (summaryVector) {
      learningRecord.summary_vector = summaryVector;
    }

    try {
      await withRetry(() => client.index({
        index: 'vigil-learnings',
        id: learningRecord.learning_id,
        document: learningRecord,
        op_type: 'create',
        refresh: 'wait_for'
      }), { label: `index ${learningRecord.learning_id}` });
    } catch (err) {
      if (err.meta?.statusCode === 409) {
        log.info(`${learningRecord.learning_id} already exists — skipping duplicate write`);
        learningRecords.push(learningRecord);
        continue;
      }
      throw err;
    }

    log.info(
      `Pattern discovery record written: ${learningRecord.learning_id} — ` +
      `"${patternName}" (${cluster.length} incidents, ${(stepOverlap * 100).toFixed(0)}% overlap)`
    );

    learningRecords.push(learningRecord);
  }

  return learningRecords;
}
