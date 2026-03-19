#!/bin/bash
set -e

# Post-deployment script to configure AKS Automatic NAP for ARM64-only nodes
# This patches the default NodePool to use ARM64 architecture instead of amd64

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Color codes for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Configuring NAP for ARM64 Nodes ===${NC}"

# Check if stack argument is provided
if [ -z "$1" ]; then
    echo -e "${RED}Error: Stack name required${NC}"
    echo "Usage: $0 <stack-name>"
    echo "Example: $0 prod"
    exit 1
fi

STACK_NAME=$1
KUBECONFIG_FILE="/tmp/${STACK_NAME}-kubeconfig.yaml"

echo -e "${YELLOW}Stack: ${STACK_NAME}${NC}"

# Export kubeconfig from Pulumi stack
echo "Exporting kubeconfig..."
cd "$PROJECT_ROOT"
pulumi stack select "$STACK_NAME"
pulumi stack output kubeconfig --show-secrets > "$KUBECONFIG_FILE"

if [ ! -f "$KUBECONFIG_FILE" ]; then
    echo -e "${RED}Error: Failed to export kubeconfig${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Kubeconfig exported${NC}"

# Wait for cluster to be ready
echo "Waiting for cluster to be ready..."
for i in {1..30}; do
    if kubectl --kubeconfig="$KUBECONFIG_FILE" get nodes &>/dev/null; then
        echo -e "${GREEN}✓ Cluster is ready${NC}"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}Error: Cluster not ready after 5 minutes${NC}"
        exit 1
    fi
    echo "  Waiting... ($i/30)"
    sleep 10
done

# Check if default NodePool exists
echo "Checking for default NodePool..."
if ! kubectl --kubeconfig="$KUBECONFIG_FILE" get nodepool default &>/dev/null; then
    echo -e "${YELLOW}Warning: default NodePool not found yet. Waiting...${NC}"
    for i in {1..12}; do
        sleep 5
        if kubectl --kubeconfig="$KUBECONFIG_FILE" get nodepool default &>/dev/null; then
            echo -e "${GREEN}✓ default NodePool is now available${NC}"
            break
        fi
        if [ $i -eq 12 ]; then
            echo -e "${RED}Error: default NodePool not found after 1 minute${NC}"
            exit 1
        fi
    done
fi

# Get current architecture setting
CURRENT_ARCH=$(kubectl --kubeconfig="$KUBECONFIG_FILE" get nodepool default -o jsonpath='{.spec.template.spec.requirements[?(@.key=="kubernetes.io/arch")].values[0]}')
echo "Current architecture: $CURRENT_ARCH"

# Patch NodePool to use ARM64 if not already set
if [ "$CURRENT_ARCH" != "arm64" ]; then
    echo "Patching default NodePool to use ARM64..."
    kubectl --kubeconfig="$KUBECONFIG_FILE" patch nodepool default --type='json' \
        -p='[{"op": "replace", "path": "/spec/template/spec/requirements/0/values", "value": ["arm64"]}]'

    echo -e "${GREEN}✓ default NodePool patched to use ARM64${NC}"

    # Verify the change
    NEW_ARCH=$(kubectl --kubeconfig="$KUBECONFIG_FILE" get nodepool default -o jsonpath='{.spec.template.spec.requirements[?(@.key=="kubernetes.io/arch")].values[0]}')
    echo -e "${GREEN}✓ Verified: Architecture is now ${NEW_ARCH}${NC}"
else
    echo -e "${GREEN}✓ NodePool already configured for ARM64${NC}"
fi

# Show NodePool configuration
echo ""
echo "Current NodePool requirements:"
kubectl --kubeconfig="$KUBECONFIG_FILE" get nodepool default -o jsonpath='{.spec.template.spec.requirements}' | jq '.'

# Cleanup
rm -f "$KUBECONFIG_FILE"

echo ""
echo -e "${GREEN}=== Configuration Complete ===${NC}"
echo -e "${YELLOW}NAP will now provision ARM64 nodes (Dpsv5/Dplsv5/Epsv5 families) for new workloads${NC}"
echo -e "${YELLOW}Existing amd64 nodes will be gradually replaced as workloads are rescheduled${NC}"
