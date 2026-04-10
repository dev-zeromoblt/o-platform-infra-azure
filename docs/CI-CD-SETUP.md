# CI/CD Setup — GitHub Actions

This project uses GitHub Actions for automated infrastructure validation, deployment, and testing.

## Pipeline Overview

### 1. PR Checks (`pr-checks.yml`)

Triggered on pull request to `main`:

```
validate → preview-dev → dev-outputs → test-dev ──→ (all pass: PR is green)
                                            └→ (any fail: request changes on PR)
```

| Job | Description |
|-----|-------------|
| **validate** | Build, lint, vulnerability scan, unit tests with coverage |
| **preview-dev** | `pulumi preview` against dev stack (posts diff as PR comment) |
| **dev-outputs** | Fetches dev stack outputs from Pulumi for integration tests |
| **test-dev** | Integration tests against dev (AKS, ACR, DNS, ingress, cert-manager, workload identity) |
| **request-changes** | If any check fails, posts a "Request Changes" review on the PR |

### 2. Deploy (`deploy.yml`)

Triggered on push/merge to `main`:

```
deploy-beta → test-beta ──→ deploy-prod → test-prod ──→ notify (success)
                  │                            │
                  └→ rollback-beta + notify     └→ rollback-prod + notify
```

| Job | Description |
|-----|-------------|
| **deploy-beta** | `pulumi up` against beta stack |
| **test-beta** | Integration tests against beta (AKS, ACR, DNS, ingress, cert-manager, workload identity) |
| **rollback-beta** | On beta test failure: `pulumi cancel` + `pulumi refresh` |
| **deploy-prod** | `pulumi up` against prod stack (only if beta tests pass) |
| **test-prod** | Integration tests against prod |
| **rollback-prod** | On prod test failure: `pulumi cancel` + `pulumi refresh` |
| **notify** | Posts a summary to the GitHub Actions step summary with per-stage results |

## Required GitHub Repository Secrets

Configure these in **Settings → Secrets and variables → Actions**:

### Pulumi

| Secret | Description | How to obtain |
|--------|-------------|---------------|
| `PULUMI_ACCESS_TOKEN` | Pulumi Cloud access token | [app.pulumi.com](https://app.pulumi.com) → Settings → Access Tokens → Create |

### Azure Service Principal

Create a service principal with Contributor access to the subscription:

```bash
az ad sp create-for-rbac \
  --name "github-actions-infra" \
  --role Contributor \
  --scopes /subscriptions/<SUBSCRIPTION_ID> \
  --sdk-auth
```

Then set these secrets from the output:

| Secret | Description | JSON key from above |
|--------|-------------|---------------------|
| `ARM_CLIENT_ID` | Service principal app ID | `clientId` |
| `ARM_CLIENT_SECRET` | Service principal password | `clientSecret` |
| `ARM_TENANT_ID` | Azure AD tenant ID | `tenantId` |
| `ARM_SUBSCRIPTION_ID` | Azure subscription ID | `subscriptionId` |

> The SP also needs **User Access Administrator** role if Pulumi manages role assignments (e.g., cluster admin RBAC).

```bash
az role assignment create \
  --assignee <ARM_CLIENT_ID> \
  --role "User Access Administrator" \
  --scope /subscriptions/<SUBSCRIPTION_ID>
```

## Local Development

```bash
# Install dependencies
yarn install

# Build
yarn build

# Run unit tests
yarn test:unit

# Run unit tests with coverage
yarn test:coverage

# Lint
yarn lint

# Run integration tests (requires Azure credentials + kubeconfig)
export AZURE_CLIENT_ID=...
export AZURE_CLIENT_SECRET=...
export AZURE_TENANT_ID=...
export AZURE_SUBSCRIPTION_ID=...
export STACK_AKSCLUSTERNAME=...
export STACK_RESOURCEGROUPNAME=...
# ... (see tests/helpers.ts for all STACK_* variables)
yarn test:integration
```

## Integration Test Environment Variables

The integration tests expect these `STACK_*` environment variables (set automatically in CI from Pulumi outputs):

| Variable | Source Pulumi Output |
|----------|---------------------|
| `STACK_AKSCLUSTERNAME` | `aksClusterName` |
| `STACK_RESOURCEGROUPNAME` | `resourceGroupName` |
| `STACK_INGRESSCONTROLLERIP` | `ingressControllerIP` |
| `STACK_ACRLOGINSERVER` | `acrLoginServer` |
| `STACK_ACRUSERNAME` | `acrUsername` |
| `STACK_ACRPASSWORD` | `acrPassword` |
| `STACK_DNSZONENAME` | `dnsZoneName` |
| `STACK_DNSRESOURCEGROUPNAME` | `dnsResourceGroupName` |
| `STACK_DOMAINNAME` | `domainName` |
