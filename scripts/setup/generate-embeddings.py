#!/usr/bin/env python3
"""Generate vector embeddings for Vigil seed data.

Dual-purpose: importable module (EmbeddingGenerator class, pseudo_vector function)
and standalone CLI that writes vectors back into seed-data JSON files.
"""

import argparse
import hashlib
import json
import math
import os
import random
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

SEED_ROOT = Path(__file__).resolve().parent.parent.parent / "seed-data"

BATCH_LIMITS = {"elastic": 10, "openai": 100, "cohere": 96}
MAX_RETRIES = 3
BASE_DELAY_S = 0.5


# ── Deterministic pseudo-vectors ────────────────────────────

def pseudo_vector(text, dims=384):
    """Generate a deterministic pseudo-vector from text content.

    Uses SHA-256 to seed a gaussian RNG, then L2-normalises the result.
    Identical to the original implementation in seed-reference-data.py.
    """
    seed = int(hashlib.sha256(text.encode()).hexdigest(), 16) % (2**32)
    rng = random.Random(seed)
    vec = [rng.gauss(0, 0.1) for _ in range(dims)]
    norm = math.sqrt(sum(v * v for v in vec))
    return [v / norm for v in vec]


# ── HTTP helper ─────────────────────────────────────────────

def _http_post(url, headers, body):
    """POST JSON and return parsed response. Raises HTTPError on failure."""
    data = json.dumps(body).encode()
    req = Request(url, data=data, headers=headers, method="POST")
    with urlopen(req) as resp:
        return json.loads(resp.read().decode())


# ── EmbeddingGenerator ──────────────────────────────────────

class EmbeddingGenerator:
    """Generate embeddings via a configurable provider (or pseudo-vectors)."""

    def __init__(self, provider=None):
        self._provider = (provider or os.getenv("EMBEDDING_PROVIDER", "")).lower().strip()
        self._use_pseudo = False

        if not self._provider:
            self._use_pseudo = True
            return

        if self._provider == "elastic":
            self._elastic_url = os.getenv("ELASTIC_URL")
            self._elastic_api_key = os.getenv("ELASTIC_API_KEY")
            if not self._elastic_url or not self._elastic_api_key:
                raise ValueError("Elastic provider requires ELASTIC_URL and ELASTIC_API_KEY")
        elif self._provider == "openai":
            self._openai_api_key = os.getenv("OPENAI_API_KEY")
            if not self._openai_api_key:
                raise ValueError("OpenAI provider requires OPENAI_API_KEY")
        elif self._provider == "cohere":
            self._cohere_api_key = os.getenv("COHERE_API_KEY")
            if not self._cohere_api_key:
                raise ValueError("Cohere provider requires COHERE_API_KEY")
        else:
            raise ValueError(
                f'Unknown provider "{self._provider}". Supported: elastic, openai, cohere'
            )

    @property
    def provider_name(self):
        return "pseudo" if self._use_pseudo else self._provider

    # ── Single text ──

    def generate(self, text):
        """Generate an embedding for a single text string."""
        if self._use_pseudo:
            return pseudo_vector(text)
        return self._call_provider([text])[0]

    # ── Batch ──

    def generate_batch(self, texts):
        """Generate embeddings for a list of texts, auto-chunked by provider limits."""
        if not texts:
            return []
        if self._use_pseudo:
            return [pseudo_vector(t) for t in texts]

        limit = BATCH_LIMITS.get(self._provider, 10)
        all_embeddings = []
        for i in range(0, len(texts), limit):
            chunk = texts[i : i + limit]
            embeddings = self._call_with_retry(chunk, label=f"batch[{i}..{i + len(chunk)}]")
            all_embeddings.extend(embeddings)
        return all_embeddings

    # ── Provider dispatch ──

    def _call_provider(self, texts):
        if self._provider == "elastic":
            return self._embed_elastic(texts)
        elif self._provider == "openai":
            return self._embed_openai(texts)
        elif self._provider == "cohere":
            return self._embed_cohere(texts)

    def _call_with_retry(self, texts, label="embed"):
        for attempt in range(MAX_RETRIES + 1):
            try:
                return self._call_provider(texts)
            except HTTPError as e:
                retryable = e.code == 429 or (500 <= e.code < 600)
                if attempt == MAX_RETRIES or not retryable:
                    raise
                delay = BASE_DELAY_S * (2 ** attempt) + random.random() * BASE_DELAY_S
                print(f"  WARN: {label} attempt {attempt + 1} failed ({e.code}), retrying in {delay:.1f}s")
                time.sleep(delay)

    # ── Elastic ──

    def _embed_elastic(self, texts):
        url = f"{self._elastic_url.rstrip('/')}/_inference/text_embedding/vigil-embedding-model"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"ApiKey {self._elastic_api_key}",
        }
        result = _http_post(url, headers, {"input": texts})
        return [item["embedding"] for item in result["text_embedding"]]

    # ── OpenAI ──

    def _embed_openai(self, texts):
        url = "https://api.openai.com/v1/embeddings"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._openai_api_key}",
        }
        body = {
            "input": texts,
            "model": "text-embedding-3-large",
            "dimensions": 384,
        }
        result = _http_post(url, headers, body)
        return [item["embedding"] for item in result["data"]]

    # ── Cohere ──

    def _embed_cohere(self, texts):
        url = "https://api.cohere.ai/v2/embed"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._cohere_api_key}",
        }
        body = {
            "texts": texts,
            "model": "embed-english-v3.0",
            "input_type": "search_document",
            "embedding_types": ["float"],
        }
        result = _http_post(url, headers, body)
        return result["embeddings"]["float"]


# ── CLI mode ────────────────────────────────────────────────

def _process_directory(generator, subdir, text_field, vector_field):
    """Read JSON files from a seed-data subdirectory and add vectors."""
    directory = SEED_ROOT / subdir
    if not directory.exists():
        return []

    processed = []
    for json_file in sorted(directory.glob("*.json")):
        data = json.loads(json_file.read_text())
        if isinstance(data, dict):
            text = data.get(text_field)
            if text:
                data[vector_field] = generator.generate(text)
                json_file.write_text(json.dumps(data, indent=2) + "\n")
                processed.append(json_file.name)
        # Arrays (baselines) don't need vectors
    return processed


def main():
    parser = argparse.ArgumentParser(description="Generate embeddings for Vigil seed data")
    parser.add_argument(
        "--provider",
        choices=["elastic", "openai", "cohere"],
        default=None,
        help="Embedding provider (overrides EMBEDDING_PROVIDER env var). Omit for pseudo-vectors.",
    )
    args = parser.parse_args()

    generator = EmbeddingGenerator(provider=args.provider)
    print(f"Embedding provider: {generator.provider_name}")
    print()

    # Runbooks — embed the 'content' field
    runbook_files = _process_directory(generator, "runbooks", "content", "content_vector")
    print(f"Runbooks: {len(runbook_files)} files processed")
    for f in runbook_files:
        print(f"  {f}")

    # Threat intel — embed the 'description' field
    intel_files = _process_directory(generator, "threat-intel", "description", "description_vector")
    print(f"Threat intel: {len(intel_files)} files processed")
    for f in intel_files:
        print(f"  {f}")

    print()
    print(f"Done. {len(runbook_files) + len(intel_files)} files updated with {generator.provider_name} embeddings.")


if __name__ == "__main__":
    main()
