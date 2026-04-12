#!/bin/bash
# ── Local / dev test runner ────────────────────────────────────────────────
# Usage: ./run-local.sh [stack] [test-pattern]
#
#   ./run-local.sh dev            # run all live tests against dev stack
#   ./run-local.sh dev aks        # run only aks.test.ts against dev
#   ./run-local.sh dev pipeline   # run static pipeline-validation only
#
# Requirements:
#   - pulumi CLI authenticated  (pulumi login)
#   - Azure CLI authenticated   (az login or service principal env vars)
#   - kubectl configured        (pulumi stack output kubeconfig)
#   - kubelogin installed       (for AKS SP auth)
#   - docker running            (for acr.test.ts)
#   - npm ci already run        (cd pipeline/tests && npm ci)
#
# Environment variables (optional — override stack outputs):
#   AZURE_SUBSCRIPTION_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID
# ──────────────────────────────────────────────────────────────────────────

set -e

STACK=${1:-dev}
PATTERN=${2:-"aks|acr|dns|ingress|cert"}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== o-platform-infra-azure local test runner ==="
echo "Stack:   $STACK"
echo "Pattern: $PATTERN"
echo ""

# ── 1. Load stack outputs into STACK_* env vars ──────────────────────────
echo "Loading stack outputs from: $STACK"
cd "$REPO_ROOT"
pulumi stack select "$STACK"
OUTPUTS=$(pulumi stack output --json)

echo "Stack outputs loaded:"
echo "$OUTPUTS" | python3 -c "import json,sys; [print(f'  STACK_{k.upper()}={v}') for k,v in json.load(sys.stdin).items() if k.lower() != 'kubeconfig']"
echo ""

# Export each output as STACK_<KEY> env var
while IFS='=' read -r key val; do
  export "$key"="$val"
done < <(echo "$OUTPUTS" | python3 -c "
import json, sys
for k, v in json.load(sys.stdin).items():
    safe = 'STACK_' + k.upper().replace('-', '_')
    print(f'{safe}={v}')
")

# ── 2. Configure kubectl from stack kubeconfig ────────────────────────────
if [ -n "$STACK_KUBECONFIG" ]; then
  echo "Configuring kubectl from stack kubeconfig..."
  mkdir -p ~/.kube
  echo "$STACK_KUBECONFIG" > ~/.kube/config-"$STACK"
  export KUBECONFIG=~/.kube/config-"$STACK"
  kubelogin convert-kubeconfig -l spn 2>/dev/null || \
    echo "Note: kubelogin not available or not needed (spn auth may already be set)"
  kubectl cluster-info 2>/dev/null || echo "Warning: kubectl cluster-info failed (continuing)"
  echo ""
fi

# ── 3. Set TEST_ENVIRONMENT ───────────────────────────────────────────────
export TEST_ENVIRONMENT="$STACK"

# ── 4. Run tests ──────────────────────────────────────────────────────────
cd "$SCRIPT_DIR"
npm ci --silent

echo "Running tests matching: $PATTERN"
echo "────────────────────────────────────────"
npx jest --testPathPattern="$PATTERN" --forceExit --verbose

echo ""
echo "=== Tests complete ==="
