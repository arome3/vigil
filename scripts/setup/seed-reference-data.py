#!/usr/bin/env python3
"""Seed reference data into Elasticsearch for the Vigil platform.

Reads JSON files from seed-data/, generates vector embeddings via
EmbeddingGenerator, and bulk-indexes into Elasticsearch.
"""

import importlib.util
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from elasticsearch import Elasticsearch, helpers

load_dotenv()

# ── Import EmbeddingGenerator from generate-embeddings.py ───

_emb_path = Path(__file__).resolve().parent / "generate-embeddings.py"
_spec = importlib.util.spec_from_file_location("generate_embeddings", _emb_path)
_emb_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_emb_module)
EmbeddingGenerator = _emb_module.EmbeddingGenerator

# ── Elasticsearch client setup ──────────────────────────────

ELASTIC_URL = os.getenv("ELASTIC_URL")
ELASTIC_API_KEY = os.getenv("ELASTIC_API_KEY")
ELASTIC_CLOUD_ID = os.getenv("ELASTIC_CLOUD_ID")

if not ELASTIC_API_KEY:
    print("ERROR: ELASTIC_API_KEY is required")
    sys.exit(1)

client_kwargs = {"api_key": ELASTIC_API_KEY}
if ELASTIC_URL:
    client_kwargs["hosts"] = [ELASTIC_URL]
elif ELASTIC_CLOUD_ID:
    client_kwargs["cloud_id"] = ELASTIC_CLOUD_ID
else:
    print("ERROR: ELASTIC_URL or ELASTIC_CLOUD_ID is required")
    sys.exit(1)

es = Elasticsearch(**client_kwargs)

# ── Seed data root ──────────────────────────────────────────

SEED_ROOT = Path(__file__).resolve().parent.parent.parent / "seed-data"


# ── JSON file loaders ───────────────────────────────────────

def load_single_docs(subdir):
    """Load JSON files where each file is a single document object."""
    directory = SEED_ROOT / subdir
    docs = []
    for json_file in sorted(directory.glob("*.json")):
        doc = json.loads(json_file.read_text())
        if isinstance(doc, dict):
            docs.append(doc)
    return docs


def load_array_docs(subdir):
    """Load JSON files where each file is an array of document objects."""
    directory = SEED_ROOT / subdir
    docs = []
    for json_file in sorted(directory.glob("*.json")):
        data = json.loads(json_file.read_text())
        if isinstance(data, list):
            docs.extend(data)
    return docs


# ── Embedding integration ───────────────────────────────────

def add_vectors(docs, text_field, vector_field, generator):
    """Generate embeddings for docs that have the given text field."""
    texts = []
    indices = []
    for i, doc in enumerate(docs):
        text = doc.get(text_field)
        if text:
            texts.append(text)
            indices.append(i)

    if not texts:
        return

    vectors = generator.generate_batch(texts)
    for idx, vec in zip(indices, vectors):
        docs[idx][vector_field] = vec


# ── Bulk indexing ───────────────────────────────────────────

def bulk_index(index, docs, id_field=None):
    """Bulk index documents with explicit _id for idempotency.

    id_field: field name to derive _id from, or None for baselines
              (which use a composite key).
    """
    actions = []
    for doc in docs:
        if id_field:
            doc_id = doc[id_field]
        else:
            # Composite key for baselines
            doc_id = f"baseline-{doc['service_name']}-{doc['metric_name']}"

        actions.append({
            "_index": index,
            "_id": doc_id,
            "_source": doc,
        })

    success, errors = helpers.bulk(es, actions, raise_on_error=False)
    return success, errors


# ── Main ────────────────────────────────────────────────────

def main():
    generator = EmbeddingGenerator()
    print(f"Embedding provider: {generator.provider_name}")

    # Load data from JSON files
    runbooks = load_single_docs("runbooks")
    assets = load_single_docs("assets")
    threat_intel = load_single_docs("threat-intel")
    baselines = load_array_docs("baselines")

    # Add vector embeddings
    add_vectors(runbooks, "content", "content_vector", generator)
    add_vectors(threat_intel, "description", "description_vector", generator)

    datasets = [
        ("vigil-runbooks", runbooks, "runbook_id"),
        ("vigil-assets", assets, "asset_id"),
        ("vigil-threat-intel", threat_intel, "ioc_id"),
        ("vigil-baselines", baselines, None),
    ]

    for index, docs, id_field in datasets:
        success, errors = bulk_index(index, docs, id_field)
        if errors:
            print(f"WARNING: {index} — {len(errors) if isinstance(errors, list) else errors} errors during indexing")
        print(f"OK: {index} — {success} documents indexed")

    # Verify counts
    print("\n--- Verification ---")
    for index, docs, _ in datasets:
        count = es.count(index=index)["count"]
        expected = len(docs)
        status = "PASS" if count >= expected else "FAIL"
        print(f"{status}: {index} — {count} documents (expected >= {expected})")


if __name__ == "__main__":
    main()
