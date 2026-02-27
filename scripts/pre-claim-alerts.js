#!/usr/bin/env node
// Pre-claim all existing alerts so the alert watcher skips them.
import client from '../src/utils/elastic-client.js';

const result = await client.search({
  index: 'vigil-alerts-default',
  size: 500,
  _source: ['alert_id'],
  query: { match_all: {} }
});

const hits = result.hits.hits;
console.log(`Found ${hits.length} existing alerts to pre-claim`);

if (hits.length === 0) process.exit(0);

const ops = [];
for (const hit of hits) {
  ops.push({ create: { _index: 'vigil-alert-claims', _id: hit._id } });
  ops.push({
    alert_id: hit._source?.alert_id || hit._id,
    claimed_at: new Date().toISOString(),
    processed_at: new Date().toISOString()
  });
}

const bulkResult = await client.bulk({ operations: ops, refresh: 'wait_for' });
let errCount = 0;
for (const item of bulkResult.items) {
  if (item.create?.error && item.create.error.type !== 'version_conflict_engine_exception') {
    errCount++;
  }
}
console.log(`Pre-claimed ${hits.length - errCount} alerts (${errCount} real errors)`);
