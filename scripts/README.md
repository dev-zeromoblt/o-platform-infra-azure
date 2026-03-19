# Deployment Scripts

This directory contains automation scripts for deploying and configuring the AKS infrastructure.

## Scripts

### 1. `deploy.sh` - Main Deployment Script

Automated deployment script that handles both infrastructure deployment and post-deployment configuration.

**Usage:**
```bash
./scripts/deploy.sh <stack-name> [pulumi-args]
```

**Examples:**
```bash
# Deploy to production (with confirmation)
./scripts/deploy.sh prod

# Deploy to production (auto-approve)
./scripts/deploy.sh prod --yes

# Deploy to dev
./scripts/deploy.sh dev --yes

# Deploy to beta
./scripts/deploy.sh beta --yes
```

**What it does:**
1. Deploys infrastructure using Pulumi
2. Automatically configures NAP to use ARM64 nodes
3. Verifies configuration
4. Displays deployment summary

---

### 2. `configure-arm64-nap.sh` - ARM64 NAP Configuration

Post-deployment script that configures AKS Automatic's Node Auto Provisioning (NAP) to provision ARM64 nodes by default.

**Usage:**
```bash
./scripts/configure-arm64-nap.sh <stack-name>
```

**Examples:**
```bash
# Configure NAP for production
./scripts/configure-arm64-nap.sh prod

# Configure NAP for dev
./scripts/configure-arm64-nap.sh dev
```

**What it does:**
1. Exports kubeconfig from Pulumi stack
2. Waits for cluster to be ready
3. Patches the default NodePool to use ARM64 architecture
4. Verifies the configuration
5. Displays NodePool requirements

**Note:** This script is automatically called by `deploy.sh`, but can be run manually if needed.

---

## ARM64 Configuration Details

### Why ARM64?

- **Cost Efficiency**: ARM64 VMs (Dpsv5/Dplsv5 families) offer better price-performance ratio
- **Performance**: Modern ARM64 processors provide excellent performance for containerized workloads
- **Compatibility**: Most container images support multi-arch (amd64/arm64)

### VM Families Used

When NAP is configured for ARM64, it will provision nodes from these families:

- **Dpsv5**: General-purpose ARM64 VMs (e.g., Standard_D2pds_v5, Standard_D4pds_v5)
- **Dplsv5**: ARM64 VMs optimized for scale-out workloads
- **Epsv5**: Memory-optimized ARM64 VMs

### How It Works

1. **System Pool**: Explicitly configured as ARM64 (Standard_D2pds_v5) in Pulumi config
2. **Default Pool (NAP)**: Patched post-deployment to use ARM64 architecture
3. **Data Pool (prod only)**: Explicitly configured as ARM64 (Standard_D2pds_v5 x3)

When workloads are deployed without explicit node selectors, NAP will automatically provision ARM64 nodes to run them.

### Workload Targeting Specific Pools

To target the production data pool specifically:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-workload
spec:
  nodeSelector:
    agentpool: data  # Target the data pool
  containers:
  - name: app
    image: myapp:latest
```

To force a specific architecture (if needed):

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-workload
spec:
  nodeSelector:
    kubernetes.io/arch: arm64  # Force ARM64
  containers:
  - name: app
    image: myapp:latest
```

---

## Deployment Workflow

### Fresh Deployment

```bash
# Deploy to production
./scripts/deploy.sh prod --yes
```

### Manual Steps (if needed)

If you need to run steps manually:

```bash
# 1. Deploy infrastructure
pulumi up --stack prod --yes

# 2. Configure ARM64 NAP
./scripts/configure-arm64-nap.sh prod
```

### Verification

After deployment, verify the configuration:

```bash
# Get kubeconfig
pulumi stack output kubeconfig --show-secrets --stack prod > prod-kubeconfig.yaml

# Check NodePool configuration
kubectl --kubeconfig=prod-kubeconfig.yaml get nodepool default -o yaml

# Verify architecture requirement
kubectl --kubeconfig=prod-kubeconfig.yaml get nodepool default -o jsonpath='{.spec.template.spec.requirements[?(@.key=="kubernetes.io/arch")].values[0]}'
# Should output: arm64

# Check nodes
kubectl --kubeconfig=prod-kubeconfig.yaml get nodes -L kubernetes.io/arch,node.kubernetes.io/instance-type
```

---

## Troubleshooting

### NAP Not Provisioning ARM64 Nodes

1. Check NodePool configuration:
   ```bash
   kubectl get nodepool default -o yaml
   ```

2. Re-run the ARM64 configuration:
   ```bash
   ./scripts/configure-arm64-nap.sh <stack-name>
   ```

### Script Fails to Export Kubeconfig

1. Verify you're logged into Pulumi:
   ```bash
   pulumi whoami
   ```

2. Verify the stack exists:
   ```bash
   pulumi stack ls
   ```

3. Manually export kubeconfig:
   ```bash
   pulumi stack output kubeconfig --show-secrets --stack <stack-name>
   ```

### Cluster Not Ready After Deployment

The configure script waits up to 5 minutes for the cluster. If it fails:

1. Check cluster status in Azure Portal
2. Wait longer and re-run:
   ```bash
   ./scripts/configure-arm64-nap.sh <stack-name>
   ```

---

## Notes

- Scripts require `kubectl`, `jq`, and `pulumi` CLI tools
- Kubeconfig files are temporarily stored in `/tmp/` and cleaned up after use
- The default NodePool is managed by AKS Automatic, hence the post-deployment patch approach
- Existing amd64 nodes will be gradually replaced as Karpenter consolidates/reschedules workloads
