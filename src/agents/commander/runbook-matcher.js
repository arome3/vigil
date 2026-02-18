// Runbook Matcher — search adapter wrapping executeSearchTool for runbook retrieval.
// Constructs semantic queries from investigation context and post-processes results
// with a composite scoring function (service overlap + success rate + search score).

import { executeSearchTool } from '../../tools/search/executor.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('commander-runbook-matcher');

const MAX_QUERY_LENGTH = 500;

// --- Query Construction ---

/**
 * Build a semantic-rich text query from investigation context.
 * Combines root cause, change correlation data, MITRE technique names,
 * and affected service names into a focused query string.
 *
 * @param {object} investigationReport
 * @param {string[]} affectedServices
 * @returns {string}
 */
function buildSearchQuery(investigationReport, affectedServices) {
  const parts = [];

  // Root cause is always present and most important for semantic matching
  if (investigationReport.root_cause) {
    parts.push(investigationReport.root_cause);
  }

  // Change correlation context enriches with deployment-specific terms
  const correlation = investigationReport.change_correlation;
  if (correlation?.matched) {
    const sha = correlation.commit_sha || correlation.sha;
    if (sha) parts.push(`deployment rollback commit ${sha}`);
  }

  // Top 3 MITRE technique names for attack-pattern matching
  const mitreMapping = investigationReport.mitre_mapping || investigationReport.mitre_techniques;
  if (Array.isArray(mitreMapping)) {
    const techniqueNames = mitreMapping
      .slice(0, 3)
      .map(t => t.technique_name || t.name || t)
      .filter(Boolean);
    if (techniqueNames.length > 0) {
      parts.push(techniqueNames.join(' '));
    }
  }

  // Affected service names
  if (affectedServices?.length > 0) {
    parts.push(affectedServices.join(' '));
  }

  const query = parts.join(' ').trim();

  // Cap at ~500 chars, truncating at a word boundary to avoid mid-word cuts
  if (query.length > MAX_QUERY_LENGTH) {
    return truncateAtWordBoundary(query, MAX_QUERY_LENGTH);
  }

  return query;
}

/**
 * Truncate a string to maxLen characters at the nearest word boundary.
 * Avoids mid-word cuts that degrade embedding model performance.
 */
function truncateAtWordBoundary(text, maxLen) {
  if (text.length <= maxLen) return text;

  // Find the last space at or before maxLen
  const lastSpace = text.lastIndexOf(' ', maxLen);
  if (lastSpace > maxLen * 0.5) {
    // Only use word boundary if it doesn't lose more than half the budget
    return text.slice(0, lastSpace);
  }
  // Fallback: hard cut (better than losing >50% of content)
  return text.slice(0, maxLen);
}

// --- Result Post-Processing ---

/**
 * Normalize a historical_success_rate value to the 0.0–1.0 range.
 * Handles both fractional (0.85) and percentage (85) formats.
 */
function normalizeSuccessRate(rate) {
  if (rate == null || typeof rate !== 'number' || rate < 0) return 0;
  // If > 1, assume it's a percentage (0–100)
  if (rate > 1) return Math.min(rate / 100, 1.0);
  return Math.min(rate, 1.0);
}

/**
 * Compute a composite score for ranking runbook relevance.
 * Weighting: 40% service overlap + 40% historical_success_rate + 20% search _score.
 *
 * @param {object} result - Single search result
 * @param {Set<string>} affectedSet - Set of affected service names (lowercased)
 * @param {number} maxSearchScore - Maximum _score across all results (for normalization)
 * @returns {number} Composite score 0.0–1.0
 */
function computeCompositeScore(result, affectedSet, maxSearchScore) {
  // Service overlap: fraction of affected services covered by this runbook
  const applicableServices = result.applicable_services || [];
  let overlapCount = 0;
  for (const svc of applicableServices) {
    if (affectedSet.has(svc.toLowerCase())) overlapCount++;
  }
  const overlapScore = affectedSet.size > 0
    ? overlapCount / affectedSet.size
    : 0;

  // Historical success rate: normalized to 0.0–1.0
  const successRate = normalizeSuccessRate(result.historical_success_rate);

  // Normalize search score to 0.0–1.0
  const normalizedSearchScore = maxSearchScore > 0
    ? (result._score || 0) / maxSearchScore
    : 0;

  return (0.4 * overlapScore) + (0.4 * successRate) + (0.2 * normalizedSearchScore);
}

/**
 * Filter and rank search results by composite score.
 *
 * @param {object[]} results - Raw search results from executeSearchTool
 * @param {string[]} affectedServices
 * @returns {object[]} Results sorted by composite score descending, with _compositeScore attached
 */
function filterAndRankResults(results, affectedServices) {
  if (!results?.length) return [];

  const affectedSet = new Set(
    (affectedServices || []).map(s => s.toLowerCase())
  );

  const maxSearchScore = Math.max(...results.map(r => r._score || 0));

  return results
    .map(result => ({
      ...result,
      _compositeScore: computeCompositeScore(result, affectedSet, maxSearchScore)
    }))
    .sort((a, b) => b._compositeScore - a._compositeScore);
}

// --- Main Export ---

/**
 * Search for matching remediation runbooks via hybrid search.
 * Returns ranked results or null if no matches found.
 *
 * @param {object} investigationReport - Investigation findings from vigil-investigator
 * @param {string[]} affectedServices - Services identified as affected
 * @returns {Promise<object[]|null>} Ranked runbook matches, or null if none found
 */
export async function searchRunbooks(investigationReport, affectedServices) {
  try {
    const query = buildSearchQuery(investigationReport, affectedServices);

    if (!query) {
      log.warn('Empty query built from investigation report — skipping runbook search');
      return null;
    }

    log.info(`Searching runbooks with ${query.length}-char query`, {
      query_preview: query.slice(0, 100)
    });

    const { results } = await executeSearchTool('vigil-search-runbooks', query);

    if (!results || results.length === 0) {
      log.info('No runbook matches found — plan will be synthesized from context');
      return null;
    }

    const ranked = filterAndRankResults(results, affectedServices);
    log.info(`Found ${ranked.length} runbook(s)`, {
      top_match: ranked[0].title,
      top_score: ranked[0]._compositeScore
    });

    return ranked;
  } catch (err) {
    log.error(`Runbook search failed: ${err.message}`);
    return null;
  }
}
