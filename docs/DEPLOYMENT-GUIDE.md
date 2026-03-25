# Production Deployment Guide

**Last Updated:** 2026-03-19
**Project:** AKS Automatic Multi-Environment Infrastructure

## Table of Contents
1. [Current Issue & Fix](#current-issue--fix)
2. [Prerequisites](#prerequisites)
3. [Initial Setup](#initial-setup)
4. [Deployment Workflow](#deployment-workflow)
5. [Post-Deployment Verification](#post-deployment-verification)
6. [Troubleshooting](#troubleshooting)

---

## Current Issue & Fix

### Problem
When deploying to production, you're encountering:
```
error: namespaces "cert-manager" is forbidden: User "1610c587-f138-4532-a530-6dcf885513c7"
cannot patch resource "namespaces" in API group "" in the namespace "cert-manager":
User does not have access to the resource in Azure.
```

### Root Cause
- AKS cluster is configured with **Azure RBAC** enabled (`enableAzureRBAC: true` in `deployments/cluster.ts:100`)
- Your user account needs Azure RBAC role assignment to manage Kubernetes resources
- Role assignment must be granted AFTER cluster creation but BEFORE deploying Kubernetes resources

### Immediate Fix

**Step 1: Set your user object ID in Pulumi config**

```bash
# Get your user object ID
USER_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv)
echo "Your Object ID: $USER_OBJECT_ID"

# Set it in Pulumi config
pulumi config set adminUserObjectId "$USER_OBJECT_ID"
```

**Step 2: Deploy (RBAC role will be automatically assigned)**

```bash
pulumi up --stack prod
```

The deployment will now automatically grant you "Azure Kubernetes Service RBAC Cluster Admin" role when creating the cluster.

---

## Prerequisites

### Required Tools
- [x] Azure CLI (`az`) - logged in and subscription set
- [x] Pulumi CLI (`pulumi`) - logged in
- [x] Node.js v20+
- [x] kubectl
- [x] jq (for scripts)

### Azure Permissions Required
Your Azure account needs:
- **Contributor** role on the subscription (for creating resources)
- **User Access Administrator** role (for assigning RBAC roles)
- Or **Owner** role (includes both)

Verify:
```bash
az role assignment list --assignee "manish@zeromoblt.com" --query "[].{Role:roleDefinitionName, Scope:scope}" -o table
```

### SSH Key
Required for cluster node access:
```bash
# If not exists
ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa

# Verify
cat ~/.ssh/id_rsa.pub
```

---

## Initial Setup

### 1. Project Setup

```bash
cd /Users/zeroman/ovalabs/azurev3/o-platform-infra-azure
npm install
pulumi login
```

### 2. Verify Azure Login

```bash
az account show
# Should show: manish@zeromoblt.com
# Subscription: e6a89fd3-6fdf-4300-a991-0b47b2bec750
```

### 3. Stack Configuration

The stacks are already configured. To view config:

```bash
# View prod config
pulumi stack select prod
pulumi config

# View dev config
pulumi stack select dev
pulumi config
```

**Important Notes:**
- **Location Mismatch**: Dev uses `centralindia`, Prod uses `southeastasia`
- **VM Sizes**: Prod uses `Standard_D4pds_v5`, but README suggests `Standard_D8ps_v5`
- **Domain**: Prod manages root domain `az.zeromoblt.com`, Dev uses `dev.az.zeromoblt.com`

---

## Deployment Workflow

### Recommended Deployment Order

1. **Dev** → 2. **Beta** → 3. **Prod**

This order allows:
- Testing in dev
- Prod can create DNS delegation for dev (configured in `index.ts:79-101`)

### Deploy to Production (Simplified)

With the `adminUserObjectId` configured, deployment is now straightforward:

#### Step 1: Set Your User Object ID (One-time setup)

```bash
pulumi stack select prod

# Get your user object ID
USER_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv)
echo "Your Object ID: $USER_OBJECT_ID"

# Set it in config
pulumi config set adminUserObjectId "$USER_OBJECT_ID"
```

#### Step 2: Deploy Everything

```bash
# Deploy all infrastructure (RBAC role assignment is automatic)
pulumi up
```

This will:
1. Create the AKS cluster
2. Automatically grant you "Azure Kubernetes Service RBAC Cluster Admin" role
3. Deploy DNS zones and records
4. Install cert-manager
5. Configure ingress controller

#### Step 3: Configure ARM64 Node Auto-Provisioning

```bash
# Run the post-deployment script
./scripts/configure-arm64-nap.sh prod
```

### Alternative: Automated Deployment Script

```bash
# This handles both infrastructure and ARM64 configuration
./scripts/deploy.sh prod --yes
```

---

## Post-Deployment Verification

### 1. Merge Kubeconfig (Recommended)

Merge the cluster kubeconfig into your default `~/.kube/config` for easy access with kubectl, k9s, and other tools:

```bash
# Get cluster name from Pulumi
CLUSTER_NAME=$(pulumi stack output aksClusterName)

# Merge into default kubeconfig with a friendly context name
az aks get-credentials \
  --resource-group prod-aks-rg \
  --name $CLUSTER_NAME \
  --overwrite-existing \
  --context prod-aks

# Verify
kubectl config get-contexts
kubectl --context prod-aks get nodes
```

**Benefits:**
- Access cluster from any terminal without setting KUBECONFIG
- Use k9s, Lens, and other Kubernetes tools
- Switch between multiple clusters easily

**Using k9s:**
```bash
# Launch k9s (uses current context)
k9s

# Or specify context explicitly
k9s --context prod-aks
```

### 1b. Alternative: Export Kubeconfig (Temporary)

If you prefer temporary kubeconfig files:

```bash
# Export kubeconfig
pulumi stack output kubeconfig --show-secrets > prod-kubeconfig.yaml
export KUBECONFIG=prod-kubeconfig.yaml

# Check nodes (should show ARM64)
kubectl get nodes -o wide

# Should see:
# - ARCH: arm64
# - Instance type: Standard_D4pds_v5
```

### 2. Verify Ingress Controller

```bash
# Check ingress service
kubectl get svc -n app-routing-system

# Get ingress IP
pulumi stack output ingressControllerIP

# Should show external IP (matches ingress service)
```

### 3. Verify Cert-Manager

```bash
# Check cert-manager pods
kubectl get pods -n cert-manager

# Check cluster issuers
kubectl get clusterissuer

# Should see:
# - letsencrypt-prod
# - letsencrypt-staging
```

### 4. Verify DNS

```bash
# Get nameservers
pulumi stack output nameServers

# Test DNS resolution
nslookup az.zeromoblt.com

# For prod, verify dev delegation
nslookup dev.az.zeromoblt.com
```

### 5. Verify ARM64 NAP Configuration

```bash
# Check default NodePool
kubectl get nodepool default -o yaml

# Verify ARM64 requirement
kubectl get nodepool default -o jsonpath='{.spec.template.spec.requirements[?(@.key=="kubernetes.io/arch")].values[0]}'
# Should output: arm64
```

### 6. Check Resource Groups

```bash
az group list --query "[?contains(name, 'prod')].{Name:name, Location:location, State:properties.provisioningState}" -o table

# Expected resource groups:
# - prod-aks-rg (southeastasia) - Main AKS resources
# - aks-dns-rg-prod (southeastasia) - DNS zone
# - MC_prod-aks-rg_aks-prod* (southeastasia) - Managed cluster resources (auto-created)
```

---

## Troubleshooting

### Issue 1: RBAC Permission Denied (Current Issue)

**Symptom:**
```
User "1610c587-f138-4532-a530-6dcf885513c7" cannot patch resource "namespaces"
```

**Solution:**
```bash
# Grant RBAC role (see Phase 2 above)
CLUSTER_ID=$(az aks show --resource-group prod-aks-rg --name aks-prod --query id -o tsv)
USER_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv)

az role assignment create \
  --assignee $USER_OBJECT_ID \
  --role "Azure Kubernetes Service RBAC Cluster Admin" \
  --scope $CLUSTER_ID

# Wait 30 seconds for propagation
sleep 30

# Retry deployment
pulumi up
```

### Issue 2: Cluster Creation Failed

**Check cluster state:**
```bash
az aks show --resource-group prod-aks-rg --name aks-prod --query "{State:provisioningState, PowerState:powerState}" -o json
```

**If failed, check activity log:**
```bash
az monitor activity-log list \
  --resource-group prod-aks-rg \
  --start-time $(date -u -d '1 hour ago' '+%Y-%m-%dT%H:%M:%SZ') \
  --query "[?contains(resourceId, 'aks-prod')]" \
  -o table
```

### Issue 3: Ingress Controller Not Found

**Symptom:**
```
error: services "nginx" is forbidden: User cannot get resource "services"
```

**This is also an RBAC issue.** Grant RBAC access (see Issue 1).

Additionally, verify ingress controller exists:
```bash
# Get kubeconfig first
az aks get-credentials --resource-group prod-aks-rg --name aks-prod --overwrite-existing

# Check ingress
kubectl get svc -n app-routing-system
```

### Issue 4: DNS Delegation Failed

**Check logs:**
```bash
pulumi logs --stack prod | grep -i "dns delegation"
```

**Verify dev stack exists:**
```bash
pulumi stack ls | grep dev
```

**Manually verify dev nameservers:**
```bash
pulumi stack select dev
pulumi stack output nameServers
```

### Issue 5: Cert-Manager Installation Fails

**Common causes:**
1. RBAC permissions (grant role as in Issue 1)
2. Namespace already exists from previous failed deployment

**Fix:**
```bash
# Delete cert-manager namespace if stuck
kubectl delete namespace cert-manager --force --grace-period=0

# Re-run deployment
pulumi up
```

### Issue 6: Location Mismatch

**Current configuration:**
- Dev: `centralindia`
- Prod: `southeastasia`

This is valid but may cause latency between stacks. Consider standardizing:

```bash
# To change prod to centralindia:
pulumi stack select prod
pulumi config set azure-native:location centralindia

# This will RECREATE the cluster and all resources
pulumi preview  # Review changes
pulumi up
```

---

## Best Practices Going Forward

### 1. Automate RBAC Role Assignment

Add RBAC role assignment to `deployments/cluster.ts` after cluster creation:

```typescript
// In deployments/cluster.ts, after managedCluster creation:

if (config.adminUserObjectId) {
    const clusterAdminRole = new azurenative.authorization.RoleAssignment(
        `${clusterName}-admin-rbac`,
        {
            principalId: config.adminUserObjectId,
            roleDefinitionId: pulumi.interpolate`/subscriptions/${azurenative.getClientConfig().then(c => c.subscriptionId)}/providers/Microsoft.Authorization/roleDefinitions/b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b`, // Azure Kubernetes Service RBAC Cluster Admin
            scope: managedCluster.id,
            principalType: "User",
        },
        {
            dependsOn: [managedCluster],
        }
    );
}
```

### 2. Use Infrastructure as Code Best Practices

- Always run `pulumi preview` before `pulumi up`
- Use `--target` for staged deployments
- Keep stack configurations in sync across environments

### 3. Security Considerations

- Rotate SSH keys regularly (see OPERATIONS.md)
- Use Azure Key Vault for sensitive configuration
- Enable audit logging
- Review RBAC assignments periodically

---

## Summary of Key Commands

```bash
# 1. Set admin user object ID (one-time setup)
pulumi config set adminUserObjectId "$(az ad signed-in-user show --query id -o tsv)"

# 2. Deploy everything
pulumi up

# 3. Configure ARM64
./scripts/configure-arm64-nap.sh prod

# 4. Merge kubeconfig for easy access
CLUSTER_NAME=$(pulumi stack output aksClusterName)
az aks get-credentials \
  --resource-group prod-aks-rg \
  --name $CLUSTER_NAME \
  --overwrite-existing \
  --context prod-aks

# 5. Verify deployment
kubectl --context prod-aks get nodes -o wide
kubectl --context prod-aks get pods --all-namespaces
pulumi stack output

# 6. Launch k9s (optional)
k9s --context prod-aks
```

---

## Next Steps

1. ✅ Fix RBAC permissions (see Current Issue & Fix)
2. ✅ Complete prod deployment
3. Deploy dev environment
4. Deploy beta environment
5. Configure DNS delegation from parent domain
6. Deploy sample application to test ingress and TLS
7. Set up monitoring and alerting

---

## Support Resources

- **Azure AKS Automatic**: https://learn.microsoft.com/azure/aks/intro-aks-automatic
- **Pulumi AKS Guide**: https://www.pulumi.com/registry/packages/azure-native/api-docs/containerservice/managedcluster/
- **Azure RBAC for AKS**: https://learn.microsoft.com/azure/aks/manage-azure-rbac

For issues, check:
- `OPERATIONS.md` - Day-to-day operations
- `TROUBLESHOOTING.md` - Common problems and solutions
- `scripts/README.md` - Deployment automation
