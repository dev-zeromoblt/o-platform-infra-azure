# Kubeconfig Setup Guide

Quick reference for accessing your AKS clusters with kubectl, k9s, Lens, and other Kubernetes tools.

## Method 1: Merge into Default Kubeconfig (Recommended)

This method merges the cluster credentials into `~/.kube/config`, making it accessible from any terminal and compatible with all Kubernetes tools.

### Production

```bash
# Get cluster name from Pulumi
pulumi stack select prod
CLUSTER_NAME=$(pulumi stack output aksClusterName)

# Merge kubeconfig
az aks get-credentials \
  --resource-group prod-aks-rg \
  --name $CLUSTER_NAME \
  --overwrite-existing \
  --context prod-aks

# Verify
kubectl config get-contexts
kubectl --context prod-aks get nodes
```

### Dev

```bash
pulumi stack select dev
CLUSTER_NAME=$(pulumi stack output aksClusterName)

az aks get-credentials \
  --resource-group dev-aks-rg \
  --name $CLUSTER_NAME \
  --overwrite-existing \
  --context dev-aks

kubectl --context dev-aks get nodes
```

### Beta

```bash
pulumi stack select beta
CLUSTER_NAME=$(pulumi stack output aksClusterName)

az aks get-credentials \
  --resource-group beta-aks-rg \
  --name $CLUSTER_NAME \
  --overwrite-existing \
  --context beta-aks

kubectl --context beta-aks get nodes
```

## Method 2: Export to File (Temporary)

Use this for temporary access or when you want isolated kubeconfig files.

```bash
# Export kubeconfig
pulumi stack select prod
pulumi stack output kubeconfig --show-secrets > prod-kubeconfig.yaml

# Use in current shell
export KUBECONFIG=prod-kubeconfig.yaml
kubectl get nodes

# Or use directly
kubectl --kubeconfig=prod-kubeconfig.yaml get nodes
```

## Switching Between Clusters

Once merged, easily switch between contexts:

```bash
# List all contexts
kubectl config get-contexts

# Switch to prod
kubectl config use-context prod-aks

# Switch to dev
kubectl config use-context dev-aks

# View current context
kubectl config current-context

# Use specific context without switching
kubectl --context prod-aks get pods
kubectl --context dev-aks get pods
```

## Using k9s

### With Merged Kubeconfig

```bash
# Use current context
k9s

# Specify context
k9s --context prod-aks
k9s --context dev-aks
k9s --context beta-aks

# Switch contexts within k9s
# Press ':ctx' then select context
```

### With Exported File

```bash
export KUBECONFIG=prod-kubeconfig.yaml
k9s
```

## Using Lens

Lens automatically detects contexts in `~/.kube/config`.

1. Open Lens
2. Click "Catalog" → "Clusters"
3. Your clusters should appear automatically:
   - prod-aks
   - dev-aks
   - beta-aks
4. Click to connect

## Troubleshooting

### "error: You must be logged in to the server"

Your Azure CLI session expired. Re-login:

```bash
az login
az account set --subscription e6a89fd3-6fdf-4300-a991-0b47b2bec750
```

### "error: context does not exist"

The context hasn't been merged. Run the merge command:

```bash
az aks get-credentials \
  --resource-group prod-aks-rg \
  --name $(pulumi stack output aksClusterName) \
  --overwrite-existing \
  --context prod-aks
```

### Check Cluster Name

If unsure about the cluster name:

```bash
pulumi stack select prod
pulumi stack output aksClusterName
```

Or list clusters in resource group:

```bash
az aks list --resource-group prod-aks-rg --query "[].name" -o table
```

### View Merged Config

```bash
# View entire kubeconfig
kubectl config view

# View specific context
kubectl config view --context=prod-aks

# View raw config file
cat ~/.kube/config
```

## Authentication Methods

The merged kubeconfig uses **Azure CLI authentication**, which means:

- ✅ Automatically refreshes tokens
- ✅ Uses your Azure identity (MFA, conditional access, etc.)
- ✅ No manual token management
- ⚠️  Requires `az login` to be active

If you export kubeconfig directly from Pulumi:
- Uses static certificates (from `listManagedClusterUserCredentials`)
- Works without Azure CLI
- Tokens may expire and need refresh

## Best Practices

### For Daily Use
✅ **Merge into default kubeconfig** - Most convenient for daily work

### For CI/CD
✅ **Use service principal with kubeconfig export** - More secure, doesn't depend on user login

### For Team Members
✅ **Everyone merges with their own Azure identity** - Each team member runs:
```bash
az login
az aks get-credentials ... --context prod-aks
```

## Context Naming Convention

Recommended naming:
- Production: `prod-aks`
- Development: `dev-aks`
- Beta/Staging: `beta-aks`

Update context name:
```bash
kubectl config rename-context old-name new-name
```

## Cleanup

Remove a context:

```bash
# Delete context
kubectl config delete-context prod-aks

# Delete cluster entry
kubectl config delete-cluster prod-aks

# Delete user entry
kubectl config unset users.clusterUser_prod-aks-rg_aks-prod22a902e8
```

## Quick Reference

```bash
# Setup (one-time)
az aks get-credentials --resource-group prod-aks-rg --name <cluster> --context prod-aks

# Daily use
kubectl config use-context prod-aks
kubectl get nodes

# k9s
k9s --context prod-aks

# Multiple commands
kubectl --context prod-aks get pods
kubectl --context dev-aks get pods

# View contexts
kubectl config get-contexts

# Current context
kubectl config current-context
```

---

**Note**: Always ensure you're using the correct context to avoid making changes to the wrong environment!
