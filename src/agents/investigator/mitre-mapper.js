// MITRE ATT&CK Mapper — maps observed attack behaviors to MITRE techniques
// using hybrid search (BM25 + kNN with RRF) via vigil-search-mitre-attack.

import { executeSearchTool } from '../../tools/search/executor.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('investigator-mitre-mapper');

/**
 * Map observed attack behaviors to MITRE ATT&CK techniques.
 *
 * Each behavior description is searched in parallel against the vigil-threat-intel
 * index (filtered to mitre_technique type). Results are deduplicated by technique ID,
 * keeping the highest score per technique.
 *
 * @param {string[]} observedBehaviors - Descriptions of observed attack behaviors
 *   (e.g. "lateral movement via RDP from 10.0.0.5 to 10.0.0.12")
 * @returns {Promise<Array<{technique_id: string, technique_name: string,
 *   tactic: string, description: string, confidence: number}>>}
 *   Sorted by confidence descending.
 */
export async function mapToMitre(observedBehaviors) {
  if (!observedBehaviors?.length) {
    return [];
  }

  log.info(`Mapping ${observedBehaviors.length} behavior(s) to MITRE ATT&CK`);

  // Search each behavior in parallel with individual error handling
  const searchResults = await Promise.all(
    observedBehaviors.map(behavior =>
      executeSearchTool('vigil-search-mitre-attack', behavior)
        .catch(err => {
          log.warn(`MITRE search failed for behavior "${behavior.slice(0, 80)}": ${err.message}`);
          return { results: [], total: 0 };
        })
    )
  );

  // Deduplicate by technique ID, keeping the highest _score per technique
  const techniqueMap = new Map();

  for (const searchResult of searchResults) {
    if (!searchResult?.results?.length) continue;

    for (const hit of searchResult.results) {
      const id = hit.mitre_technique_id;
      if (!id) continue;

      const score = hit._score ?? 0;
      const existing = techniqueMap.get(id);

      if (!existing || score > existing._score) {
        techniqueMap.set(id, {
          technique_id: id,
          technique_name: hit.mitre_technique_name ?? '',
          tactic: hit.mitre_tactic ?? '',
          description: hit.description ?? '',
          confidence: score,
          _score: score
        });
      }
    }
  }

  // Sort by confidence descending and strip internal _score field
  const techniques = [...techniqueMap.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .map(({ _score, ...technique }) => technique);

  log.info(`Mapped to ${techniques.length} unique MITRE technique(s)`);
  return techniques;
}
