# AKS Automatic Multi-Environment Infrastructure

Production-ready Pulumi TypeScript project deploying 3 AKS Automatic clusters (dev, beta, prod) in Azure Central India with ARM64 nodes, RBAC/OIDC, DNS zones, and ingress controllers.

## Architecture Overview

- **AKS Automatic Mode**: All clusters use AKS Automatic SKU with Standard tier
- **ARM64 Cost Optimization**: Dpdsv5 series with ephemeral OS support (~20% cheaper than x86_64)
  - Note: Use Dpdsv5 (with 'd'), NOT Dpsv5 (without 'd'). Only Dpdsv5 supports ephemeral OS disks required by AKS Automatic.
- **Node Auto-Provisioning (NAP)**: Automatic node creation based on workload demands
- **Managed Networking**: Azure CNI Overlay + Cilium pre-configured
- **Managed Ingress**: NGINX ingress controller included
- **OIDC/Workload Identity**: AWS federation support

## Prerequisites

1. **Azure CLI**: Install and login
   ```bash
   az login
   az account set --subscription <subscription-id>
   ```

2. **Pulumi CLI**: Install Pulumi
   ```bash
   curl -fsSL https://get.pulumi.com | sh
   ```

3. **Node.js**: Version 20 or later
   ```bash
   node --version  # Should be v20.x or higher
   ```

4. **SSH Key**: Required for cluster node access
   ```bash
   ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa
   ```

## Setup

1. **Clone and install dependencies**:
   ```bash
   cd o-platform-infra-azure
   npm install
   ```

2. **Login to Pulumi**:
   ```bash
   pulumi login
   ```

## Deployment

### Deploy Dev Environment

```bash
pulumi stack init dev
pulumi config set azure-native:location centralindia
pulumi config set o-platform-infra-azure:environment dev
pulumi config set o-platform-infra-azure:kubernetesVersion "1.32"
pulumi config set o-platform-infra-azure:systemPoolVmSize Standard_D2ps_v5
pulumi config set o-platform-infra-azure:systemPoolMinCount 1
pulumi config set o-platform-infra-azure:systemPoolMaxCount 3
pulumi config set o-platform-infra-azure:domain dev.az.zeromoblt.com
pulumi config set o-platform-infra-azure:sshPubKey "$(cat ~/.ssh/id_rsa.pub)"
pulumi up
```

### Deploy Beta Environment

```bash
pulumi stack init beta
pulumi config set azure-native:location centralindia
pulumi config set o-platform-infra-azure:environment beta
pulumi config set o-platform-infra-azure:kubernetesVersion "1.32"
pulumi config set o-platform-infra-azure:systemPoolVmSize Standard_D4ps_v5
pulumi config set o-platform-infra-azure:systemPoolMinCount 2
pulumi config set o-platform-infra-azure:systemPoolMaxCount 6
pulumi config set o-platform-infra-azure:domain beta.az.zeromoblt.com
pulumi config set o-platform-infra-azure:sshPubKey "$(cat ~/.ssh/id_rsa.pub)"
pulumi up
```

### Deploy Prod Environment

```bash
pulumi stack init prod
pulumi config set azure-native:location centralindia
pulumi config set o-platform-infra-azure:environment prod
pulumi config set o-platform-infra-azure:kubernetesVersion "1.32"
pulumi config set o-platform-infra-azure:systemPoolVmSize Standard_D8ps_v5
pulumi config set o-platform-infra-azure:systemPoolMinCount 3
pulumi config set o-platform-infra-azure:systemPoolMaxCount 10
pulumi config set o-platform-infra-azure:domain az.zeromoblt.com
pulumi config set o-platform-infra-azure:sshPubKey "$(cat ~/.ssh/id_rsa.pub)"
pulumi up
```

## Accessing Clusters

### Option 1: Merge Kubeconfig (Recommended)

Merge into your default `~/.kube/config` for easy access:

```bash
# Get cluster name
CLUSTER_NAME=$(pulumi stack output aksClusterName)

# Merge kubeconfig with friendly context name
az aks get-credentials \
  --resource-group prod-aks-rg \
  --name $CLUSTER_NAME \
  --overwrite-existing \
  --context prod-aks

# Use kubectl or k9s
kubectl --context prod-aks get nodes
k9s --context prod-aks
```

### Option 2: Export Kubeconfig (Temporary)

For temporary access in current shell:

```bash
pulumi stack output kubeconfig --show-secrets > kubeconfig-prod.yaml
export KUBECONFIG=kubeconfig-prod.yaml
kubectl get nodes
```

### Verify Deployment

```bash
# Check nodes (should show ARM64 architecture)
kubectl get nodes -o wide

# Check system pods
kubectl get pods -n kube-system

# Check ingress controller
kubectl get svc -n app-routing-system

# Check cert-manager
kubectl get pods -n cert-manager
```

## DNS Configuration

After deployment, configure domain delegation:

1. Get name servers:
   ```bash
   pulumi stack output nameServers
   ```

2. Add NS records to parent domain pointing to these name servers

3. Verify DNS resolution:
   ```bash
   nslookup dev.az.zeromoblt.com
   ```

## Stack Outputs

Each stack exports:
- `kubeconfig`: Admin kubeconfig for cluster access (secret)
- `oidcIssuerUrl`: OIDC issuer URL for workload identity
- `ingressControllerIP`: LoadBalancer IP for ingress
- `domain`: Configured domain name
- `nameServers`: DNS zone name servers
- `clusterName`: AKS cluster name
- `resourceGroupName`: Resource group name

## Using Stack References

Reference infrastructure from other Pulumi projects:

```typescript
import * as pulumi from "@pulumi/pulumi";

const infraStack = new pulumi.StackReference("org/o-platform-infra-azure/prod");
const kubeconfig = infraStack.getOutput("kubeconfig");
const oidcIssuer = infraStack.getOutput("oidcIssuerUrl");
```

## AWS Identity Federation

Configure AWS IAM for workload identity:

1. Get OIDC issuer URL:
   ```bash
   pulumi stack output oidcIssuerUrl
   ```

2. Create AWS IAM OIDC Identity Provider:
   ```bash
   aws iam create-open-id-connect-provider \
     --url <oidc-issuer-url> \
     --client-id-list api://AzureADTokenExchange
   ```

3. Create IAM role with trust policy and attach to K8s ServiceAccount

## Cost Estimates

- **Dev**: ~$70/month (1-3x D2ps_v5 ARM64)
- **Beta**: ~$280/month (2-6x D4ps_v5 ARM64)
- **Prod**: ~$840/month (3-10x D8ps_v5 ARM64)
- NAP provisions additional nodes dynamically as needed

## Workload Deployment Pattern

Deploy workloads with node selectors for ARM64:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      nodeSelector:
        kubernetes.io/arch: arm64
      containers:
      - name: my-app
        image: myapp:latest
```

NAP will automatically provision appropriate ARM64 nodes.

## Troubleshooting

### Cluster not accessible
- Verify kubeconfig: `pulumi stack output kubeconfig --show-secrets`
- Check Azure credentials: `az account show`

### Ingress not working
- Verify ingress service: `kubectl get svc -n app-routing-system`
- Check DNS A record: `nslookup <domain>`

### Cert-manager issues
- Check logs: `kubectl logs -n cert-manager -l app=cert-manager`
- Verify ClusterIssuer: `kubectl get clusterissuer`

## References

- [AKS Automatic Documentation](https://learn.microsoft.com/en-us/azure/aks/intro-aks-automatic)
- [ARM64 VM Series](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/dpsv5-series)
- [Paul Yu's AKS Automatic Guide](https://paulyu.dev/article/deploying-aks-automatic-with-pulumi/)
