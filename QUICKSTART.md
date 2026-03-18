# Quick Start Guide

Get your AKS Automatic cluster running in 15 minutes.

## Prerequisites (5 minutes)

```bash
# Install Azure CLI
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# Install Pulumi
curl -fsSL https://get.pulumi.com | sh

# Install Node.js
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20

# Login to Azure
az login
az account set --subscription "Your Subscription"

# Verify SSH key exists
ls ~/.ssh/id_rsa.pub || ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa -N ""
```

## Deploy Dev Cluster (10 minutes)

```bash
# Clone project
cd /Users/zeroman/ovalabs/o-platform-infra-azure

# Install dependencies
npm install

# Login to Pulumi
pulumi login

# Initialize dev stack
pulumi stack init dev

# Configure stack (copy-paste all at once)
pulumi config set azure-native:location centralindia
pulumi config set o-platform-infra-azure:environment dev
pulumi config set o-platform-infra-azure:kubernetesVersion "1.32"
pulumi config set o-platform-infra-azure:systemPoolVmSize Standard_D2ps_v5
pulumi config set o-platform-infra-azure:systemPoolMinCount 1
pulumi config set o-platform-infra-azure:systemPoolMaxCount 3
pulumi config set o-platform-infra-azure:domain dev.az.zeromoblt.com
pulumi config set o-platform-infra-azure:certManagerEmail admin@zeromoblt.com
pulumi config set o-platform-infra-azure:sshPubKey "$(cat ~/.ssh/id_rsa.pub)"

# Deploy cluster (takes ~10 minutes)
pulumi up
```

## Access Your Cluster

```bash
# Get kubeconfig
pulumi stack output kubeconfig --show-secrets > kubeconfig-dev.yaml
export KUBECONFIG=$(pwd)/kubeconfig-dev.yaml

# Verify cluster
kubectl get nodes
kubectl get pods --all-namespaces

# Get cluster info
pulumi stack output
```

## Deploy Test Application

```bash
# Deploy hello-world app with TLS
kubectl apply -f examples/test-app.yaml

# Wait for certificate (2-3 minutes)
kubectl get certificate -w

# Get ingress IP
kubectl get ingress

# Test (after DNS delegation)
curl https://hello.dev.az.zeromoblt.com
```

## Configure DNS (One-time)

```bash
# Get name servers
pulumi stack output nameServers

# Add NS records to parent domain (zeromoblt.com):
# - Subdomain: dev.az
# - Name servers: (from output above)

# Wait 5-30 minutes for DNS propagation
# Verify
nslookup dev.az.zeromoblt.com
```

## Test Node Auto-Provisioning

```bash
# Deploy workload that triggers NAP
kubectl apply -f examples/nap-test.yaml

# Watch nodes being created
kubectl get nodes -w

# See NAP in action
kubectl get nodepools

# Cleanup (watch nodes scale down after 10 min)
kubectl delete -f examples/nap-test.yaml
```

## Deploy Beta and Prod

```bash
# Beta
pulumi stack init beta
# Copy config from Pulumi.beta.yaml and adjust sshPubKey
pulumi config set o-platform-infra-azure:sshPubKey "$(cat ~/.ssh/id_rsa.pub)"
pulumi up

# Prod
pulumi stack init prod
# Copy config from Pulumi.prod.yaml and adjust sshPubKey
pulumi config set o-platform-infra-azure:sshPubKey "$(cat ~/.ssh/id_rsa.pub)"
pulumi up
```

## Key Outputs

Every stack provides:
- `kubeconfig`: Cluster access credentials
- `oidcIssuerUrl`: For workload identity/AWS federation
- `ingressControllerIP`: LoadBalancer IP
- `nameServers`: DNS delegation
- `domain`: Configured domain

## Stack References (Advanced)

Use infrastructure from other Pulumi projects:

```typescript
const infraStack = new pulumi.StackReference("org/o-platform-infra-azure/prod");
const kubeconfig = infraStack.getOutput("kubeconfig");
const k8sProvider = new k8s.Provider("k8s", { kubeconfig });
```

## Next Steps

- Read [DEPLOYMENT.md](DEPLOYMENT.md) for detailed deployment guide
- Review [OPERATIONS.md](OPERATIONS.md) for daily operations
- See [README.md](README.md) for architecture overview
- Check [examples/](examples/) for more Kubernetes manifests

## Cost Summary

| Environment | VM Size | Min-Max Nodes | Monthly Cost |
|-------------|---------|---------------|--------------|
| Dev | D2ps_v5 (ARM64) | 1-3 | ~$70 |
| Beta | D4ps_v5 (ARM64) | 2-6 | ~$280 |
| Prod | D8ps_v5 (ARM64) | 3-10 | ~$840 |

NAP provisions additional nodes dynamically as needed.

## Troubleshooting

**Can't access cluster?**
```bash
pulumi stack output kubeconfig --show-secrets > kubeconfig.yaml
export KUBECONFIG=$(pwd)/kubeconfig.yaml
kubectl cluster-info
```

**Ingress not working?**
```bash
kubectl get svc -n app-routing-system
kubectl logs -n app-routing-system -l app=nginx
```

**Certificate not issuing?**
```bash
kubectl get certificate
kubectl describe certificate <name>
kubectl logs -n cert-manager -l app=cert-manager
```

## Support

- Issues: https://github.com/anthropics/claude-code/issues
- AKS Automatic Docs: https://learn.microsoft.com/en-us/azure/aks/intro-aks-automatic
- Pulumi Docs: https://www.pulumi.com/docs/
