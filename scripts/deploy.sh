#!/bin/bash
set -e

# Automated deployment script for AKS infrastructure
# This script deploys the infrastructure and automatically configures post-deployment settings

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Color codes for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  AKS Infrastructure Deployment Script         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"
echo ""

# Check if stack argument is provided
if [ -z "$1" ]; then
    echo -e "${RED}Error: Stack name required${NC}"
    echo "Usage: $0 <stack-name> [pulumi-args]"
    echo "Example: $0 prod"
    echo "Example: $0 prod --yes"
    exit 1
fi

STACK_NAME=$1
shift # Remove stack name from arguments
PULUMI_ARGS="$@"

echo -e "${YELLOW}Stack: ${STACK_NAME}${NC}"
echo -e "${YELLOW}Pulumi Args: ${PULUMI_ARGS:-none}${NC}"
echo ""

# Navigate to project root
cd "$PROJECT_ROOT"

# Step 1: Deploy infrastructure with Pulumi
echo -e "${GREEN}=== Step 1: Deploying Infrastructure ===${NC}"
pulumi stack select "$STACK_NAME"
pulumi up --stack "$STACK_NAME" $PULUMI_ARGS

if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Pulumi deployment failed${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Infrastructure deployment complete${NC}"
echo ""

# Step 2: Configure NAP for ARM64
echo -e "${GREEN}=== Step 2: Configuring NAP for ARM64 ===${NC}"
"$SCRIPT_DIR/configure-arm64-nap.sh" "$STACK_NAME"

if [ $? -ne 0 ]; then
    echo -e "${YELLOW}Warning: ARM64 NAP configuration failed${NC}"
    echo -e "${YELLOW}You can manually run: ./scripts/configure-arm64-nap.sh $STACK_NAME${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Deployment Complete!                          ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}Summary:${NC}"
echo -e "  • Infrastructure deployed to ${BLUE}${STACK_NAME}${NC}"
echo -e "  • NAP configured for ARM64 nodes"
echo -e "  • System pool: Standard_D2pds_v5 (ARM64)"
if [ "$STACK_NAME" == "prod" ]; then
    echo -e "  • Data pool: Standard_D2pds_v5 x3 (ARM64)"
fi
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo -e "  • Get cluster credentials: ${BLUE}pulumi stack output kubeconfig --show-secrets --stack ${STACK_NAME} > kubeconfig.yaml${NC}"
echo -e "  • Access cluster: ${BLUE}kubectl --kubeconfig=kubeconfig.yaml get nodes${NC}"
echo ""
