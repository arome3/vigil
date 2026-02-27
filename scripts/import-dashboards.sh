#!/usr/bin/env bash
set -euo pipefail

# ─── Colors ─────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

fail() {
  echo -e "${RED}FAILED:${NC} $1" >&2
  exit 1
}

ok() {
  echo -e "  ${GREEN}✓${NC} $1"
}

warn() {
  echo -e "  ${YELLOW}⚠${NC} $1"
}

# ─── Pre-flight ─────────────────────────────────────────────
echo -e "${BLUE}Vigil Dashboard Import${NC}"
echo "─────────────────────────────────────────────"

# Source .env if present
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$PROJECT_ROOT/.env" ]; then
  source "$PROJECT_ROOT/.env" 2>/dev/null || true
  ok ".env loaded"
fi

# Validate required env vars
if [ -z "${KIBANA_URL:-}" ]; then
  fail "KIBANA_URL is not set. Export it or add it to .env"
fi

if [ -z "${ELASTIC_API_KEY:-}" ]; then
  fail "ELASTIC_API_KEY is not set. Export it or add it to .env"
fi

ok "Environment variables set"

# Check curl is available
if ! command -v curl &>/dev/null; then
  fail "curl is not installed"
fi

# ─── Resolve NDJSON files ──────────────────────────────────
DASHBOARD_DIR="$PROJECT_ROOT/kibana/dashboards"
NDJSON_FILES=("$DASHBOARD_DIR"/*.ndjson)

if [ ${#NDJSON_FILES[@]} -eq 0 ]; then
  fail "No NDJSON files found in $DASHBOARD_DIR"
fi

ok "Found ${#NDJSON_FILES[@]} NDJSON file(s)"

# ─── Import ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}Importing dashboards...${NC}"

TOTAL_SUCCESS=0
ERRORS=0

for NDJSON_PATH in "${NDJSON_FILES[@]}"; do
  FILENAME=$(basename "$NDJSON_PATH")
  echo ""
  echo -e "  Importing ${YELLOW}${FILENAME}${NC} ..."

  RESPONSE=$(curl -s -w "\n%{http_code}" \
    --connect-timeout 10 \
    --max-time 60 \
    --retry 3 \
    --retry-delay 2 \
    -X POST "${KIBANA_URL}/api/saved_objects/_import?overwrite=true" \
    -H "kbn-xsrf: true" \
    -H "Authorization: ApiKey ${ELASTIC_API_KEY}" \
    --form file=@"$NDJSON_PATH")

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" -ne 200 ]; then
    warn "Kibana API returned HTTP $HTTP_CODE for $FILENAME. First 200 chars: $(echo "$BODY" | head -c 200)"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  # Guard: verify response is JSON before parsing with grep
  if ! echo "$BODY" | grep -q '^{'; then
    warn "Unexpected response from Kibana for $FILENAME (not JSON)"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  # Parse response
  SUCCESS=$(echo "$BODY" | grep -o '"success":true' || true)
  if [ -z "$SUCCESS" ]; then
    warn "Import may have partial failures for $FILENAME. Response:"
    echo "$BODY"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  SUCCESS_COUNT=$(echo "$BODY" | grep -o '"successCount":[0-9]*' | grep -o '[0-9]*' || echo "0")
  TOTAL_SUCCESS=$((TOTAL_SUCCESS + SUCCESS_COUNT))
  ok "$FILENAME — $SUCCESS_COUNT saved objects"
done

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  fail "$ERRORS file(s) had import errors"
fi

ok "Imported $TOTAL_SUCCESS total saved objects"

# ─── Print dashboard URLs ──────────────────────────────────
echo ""
echo "─────────────────────────────────────────────"
echo -e "${GREEN}Import complete.${NC} Open the dashboards in Kibana:"
echo ""
echo -e "  ${BLUE}Command Center:${NC}"
echo "  ${KIBANA_URL}/app/dashboards#/view/vigil-dash-command-center"
echo ""
echo -e "  ${BLUE}Incident Detail:${NC}"
echo "  ${KIBANA_URL}/app/dashboards#/view/vigil-dash-incident-detail"
echo ""
echo -e "  ${BLUE}Reports:${NC}"
echo "  ${KIBANA_URL}/app/dashboards#/view/vigil-dash-reports"
echo ""
echo -e "  Tip: Command Center auto-refreshes every ${YELLOW}5 seconds${NC}. Adjust in the time picker if needed."
