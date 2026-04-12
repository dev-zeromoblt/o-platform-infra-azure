#!/bin/bash
# OPlatform Azure Environment Setup
set -e

ENVIRONMENT=${1:-"beta"}
SUBSCRIPTION_ID=${2:-""}

echo "=== OPlatform Azure Environment Setup: $ENVIRONMENT ==="

check_env_vars() {
    local required=("AZURE_CLIENT_ID" "AZURE_CLIENT_SECRET" "AZURE_TENANT_ID" "PULUMI_ACCESS_TOKEN")
    for var in "${required[@]}"; do
        if [ -z "${!var}" ]; then
            echo "Error: Missing required variable: $var"
            exit 1
        fi
    done
    echo "✓ All required environment variables are set"
}

install_azure_cli() {
    if ! command -v az &>/dev/null; then
        curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
    fi
    az version
}

azure_login() {
    az login --service-principal \
        --username "$AZURE_CLIENT_ID" \
        --password "$AZURE_CLIENT_SECRET" \
        --tenant "$AZURE_TENANT_ID"
    if [ -n "$SUBSCRIPTION_ID" ]; then
        az account set --subscription "$SUBSCRIPTION_ID"
    fi
    echo "✓ Azure CLI authenticated"
}

install_pulumi() {
    if ! command -v pulumi &>/dev/null; then
        curl -fsSL https://get.pulumi.com | sh
        export PATH=$PATH:$HOME/.pulumi/bin
    fi
    pulumi login
    pulumi whoami
}

install_kubelogin() {
    if ! command -v kubelogin &>/dev/null; then
        KUBELOGIN_VERSION="v0.1.4"
        curl -LO "https://github.com/Azure/kubelogin/releases/download/${KUBELOGIN_VERSION}/kubelogin-linux-amd64.zip"
        unzip -q kubelogin-linux-amd64.zip
        sudo mv bin/linux_amd64/kubelogin /usr/local/bin/
        rm -rf bin kubelogin-linux-amd64.zip
    fi
    kubelogin --version
}

main() {
    check_env_vars
    install_azure_cli
    azure_login
    install_pulumi
    install_kubelogin
    echo "=== Setup complete for: $ENVIRONMENT ==="
}

main "$@"
