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

step() {
  echo -e "\n${BLUE}[$1/9]${NC} $2"
}

ok() {
  echo -e "  ${GREEN}✓${NC} $1"
}

warn() {
  echo -e "  ${YELLOW}⚠${NC} $1"
}

# ─── Pre-flight checks ─────────────────────────────────────
echo -e "${BLUE}Vigil Bootstrap${NC}"
echo "─────────────────────────────────────────────"

# Check .env exists
if [ ! -f .env ]; then
  fail ".env file not found. Copy .env.example to .env and fill in your values."
fi
ok ".env file found"

# Check Node.js >= 20
if ! command -v node &>/dev/null; then
  fail "node is not installed. Install Node.js >= 20."
fi
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  fail "Node.js >= 20 required (found v$(node -v))"
fi
ok "Node.js v$(node -v)"

# Check Python3 >= 3.11
if ! command -v python3 &>/dev/null; then
  fail "python3 is not installed. Install Python >= 3.11."
fi
PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)
if [ "$PYTHON_MAJOR" -lt 3 ] || { [ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -lt 11 ]; }; then
  fail "Python >= 3.11 required (found $PYTHON_VERSION)"
fi
ok "Python $PYTHON_VERSION"

# ─── Env validation ─────────────────────────────────────────
source .env 2>/dev/null || true

MISSING=()
for var in ELASTIC_URL ELASTIC_API_KEY KIBANA_URL LLM_PROVIDER LLM_MODEL LLM_API_KEY; do
  if [ -z "${!var:-}" ]; then
    MISSING+=("$var")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  fail "Missing required environment variables: ${MISSING[*]}"
fi
ok "All required environment variables set"

echo ""

# ─── Bootstrap steps ────────────────────────────────────────

step 1 "Create ILM policies"
node scripts/setup/create-ilm-policies.js || fail "ILM policy creation failed"
ok "ILM policies created"

step 2 "Create index templates"
node scripts/setup/create-index-templates.js || fail "Index template creation failed"
ok "Index templates created"

step 3 "Create data streams and indices"
node scripts/setup/create-data-streams.js || fail "Data stream creation failed"
ok "Data streams and indices created"

step 4 "Configure inference endpoint"
node scripts/setup/configure-inference-endpoint.js || fail "Inference endpoint configuration failed"
ok "Inference endpoint configured"

step 5 "Create ingest pipelines"
node scripts/setup/create-ingest-pipelines.js || fail "Ingest pipeline creation failed"
ok "Ingest pipelines created"

step 6 "Seed reference data"
python3 scripts/setup/seed-reference-data.py || fail "Seed data loading failed"
ok "Reference data seeded"

step 7 "Register ES|QL tools"
node scripts/setup/register-esql-tools.js || fail "ES|QL tool registration failed"
ok "ES|QL tools registered"

step 8 "Provision agents"
node scripts/setup/provision-agents.js || fail "Agent provisioning failed"
ok "Agents provisioned"

step 9 "Deploy workflows"
node scripts/setup/deploy-workflows.js || fail "Workflow deployment failed"
ok "Workflows deployed"

# ─── Done ───────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────"
echo -e "${GREEN}Bootstrap complete.${NC} Run ${BLUE}npm run dev${NC} to start webhook server."
