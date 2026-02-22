import { embedText } from '../embeddings/embedding-service.js';

/**
 * Safely embed text, returning undefined on failure with a warning log.
 *
 * Wraps the embedText call in Promise.allSettled so a single embedding
 * failure never crashes the caller.
 *
 * @param {string} text - Text to embed
 * @param {object} log - Logger instance (must have .warn)
 * @param {string} label - Context label for the warning message
 * @returns {Promise<number[]|undefined>} Embedding vector, or undefined on failure
 */
export async function embedSafe(text, log, label) {
  const [result] = await Promise.allSettled([embedText(text)]);
  if (result.status === 'fulfilled') {
    return result.value;
  }
  log.warn(`Failed to generate embedding for ${label}: ${result.reason?.message}`);
  return undefined;
}
