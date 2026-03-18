# Operations Guide

## Daily Operations

### Switching Between Environments

```bash
# List all stacks
pulumi stack ls

# Switch to dev
pulumi stack select dev
export KUBECONFIG=$(pulumi stack output kubeconfig --show-secrets)

# Switch to beta
pulumi stack select beta
export KUBECONFIG=$(pulumi stack output kubeconfig --show-secrets)

# Switch to prod
pulumi stack select prod
export KUBECONFIG=$(pulumi stack output kubeconfig --show-secrets)
```

### Viewing Stack Outputs

```bash
# View all outputs
pulumi stack output

# View specific output
pulumi stack output oidcIssuerUrl
pulumi stack output ingressControllerIP
pulumi stack output nameServers

# View secret outputs (like kubeconfig)
pulumi stack output kubeconfig --show-secrets
```

### Using Stack References in Other Projects

```typescript
// In another Pulumi project (e.g., application deployment)
import * as pulumi from "@pulumi/pulumi";

const infraStack = new pulumi.StackReference("organization/o-platform-infra-azure/prod");

const kubeconfig = infraStack.getOutput("kubeconfig");
const oidcIssuer = infraStack.getOutput("oidcIssuerUrl");
const ingressIP = infraStack.getOutput("ingressControllerIP");

// Use these outputs to deploy applications
const k8sProvider = new k8s.Provider("k8s-prod", {
    kubeconfig: kubeconfig,
});
```

## Cluster Management

### Upgrading Kubernetes Version

```bash
# List available versions
az aks get-versions --location centralindia --output table

# Update configuration
pulumi stack select prod
pulumi config set kubernetesVersion "1.33"

# Preview changes
pulumi preview

# Apply upgrade (rolling upgrade)
pulumi up
```

### Scaling System Node Pool

```bash
# Update min/max node counts
pulumi config set systemPoolMinCount 5
pulumi config set systemPoolMaxCount 15

# Apply changes
pulumi up
```

### Changing VM Size (Requires Recreation)

**Warning**: Changing VM size requires node pool recreation. Plan for downtime.

```bash
# Update VM size
pulumi config set systemPoolVmSize Standard_D16ps_v5

# Preview (will show replacement)
pulumi preview

# Apply changes
pulumi up
```

## Monitoring and Observability

### Cluster Health Checks

```bash
# Check cluster status
kubectl get nodes
kubectl get pods --all-namespaces
kubectl top nodes
kubectl top pods --all-namespaces

# Check ingress controller
kubectl get svc -n app-routing-system
kubectl get pods -n app-routing-system

# Check cert-manager
kubectl get pods -n cert-manager
kubectl get certificates --all-namespaces
```

### Azure Portal Monitoring

```bash
# Open cluster in Azure Portal
az aks browse --resource-group prod-aks-rg --name aks-prod

# View metrics
az monitor metrics list \
  --resource /subscriptions/{subscription-id}/resourceGroups/prod-aks-rg/providers/Microsoft.ContainerService/managedClusters/aks-prod \
  --metric-names "node_cpu_usage_percentage,node_memory_working_set_percentage"
```

### Node Auto-Provisioning (NAP) Monitoring

```bash
# View node pools (includes NAP-created pools)
kubectl get nodepools

# Check node pool status
kubectl describe nodepool <nodepool-name>

# View events related to node provisioning
kubectl get events --all-namespaces | grep -i nodepool
```

## Security Operations

### Rotating SSH Keys

```bash
# Generate new SSH key
ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa_new

# Update configuration
pulumi config set sshPubKey "$(cat ~/.ssh/id_rsa_new.pub)"

# Apply changes
pulumi up

# Verify
az aks show --resource-group prod-aks-rg --name aks-prod --query linuxProfile.ssh.publicKeys
```

### Reviewing RBAC Permissions

```bash
# List role bindings
kubectl get rolebindings --all-namespaces
kubectl get clusterrolebindings

# Describe specific binding
kubectl describe clusterrolebinding <binding-name>
```

### Auditing Workload Identity

```bash
# List service accounts with workload identity
kubectl get serviceaccount --all-namespaces -o json | \
  jq '.items[] | select(.metadata.annotations["azure.workload.identity/client-id"] != null)'

# View federated credentials in Azure
az identity federated-credential list \
  --identity-name <identity-name> \
  --resource-group <resource-group>
```

## DNS Management

### Adding New DNS Records

```bash
# Using Azure CLI
az network dns record-set a add-record \
  --resource-group dns-rg-prod \
  --zone-name az.zeromoblt.com \
  --record-set-name app \
  --ipv4-address <ip-address>

# Or using Pulumi (recommended)
# Add to index.ts:
const appARecord = createDnsARecord(
    dnsZone.name,
    dnsResourceGroup.name,
    "app",
    appIngressIP,
    environment
);
```

### Verifying DNS Propagation

```bash
# Check DNS records
az network dns record-set a list \
  --resource-group dns-rg-prod \
  --zone-name az.zeromoblt.com \
  --output table

# Test resolution
nslookup app.az.zeromoblt.com
dig app.az.zeromoblt.com

# Check from different locations
curl https://dns.google/resolve?name=app.az.zeromoblt.com
```

## Certificate Management

### Checking Certificate Status

```bash
# List all certificates
kubectl get certificates --all-namespaces

# Check specific certificate
kubectl describe certificate <cert-name> -n <namespace>

# View certificate details
kubectl get secret <cert-secret> -n <namespace> -o jsonpath='{.data.tls\.crt}' | \
  base64 -d | openssl x509 -text -noout
```

### Forcing Certificate Renewal

```bash
# Delete certificate secret to trigger renewal
kubectl delete secret <cert-secret> -n <namespace>

# Or delete and recreate certificate resource
kubectl delete certificate <cert-name> -n <namespace>
kubectl apply -f <ingress-file>.yaml
```

### Switching from Staging to Production Issuer

```bash
# Update ingress annotation
kubectl patch ingress <ingress-name> -n <namespace> \
  -p '{"metadata":{"annotations":{"cert-manager.io/cluster-issuer":"letsencrypt-prod"}}}'

# Delete old certificate to trigger new issuance
kubectl delete certificate <cert-name> -n <namespace>
```

## Backup and Disaster Recovery

### Backing Up Kubernetes Resources

```bash
# Export all resources (not recommended for large clusters)
kubectl get all --all-namespaces -o yaml > backup.yaml

# Better: Use Velero for backup and restore
# Install Velero
velero install \
  --provider azure \
  --bucket <backup-container> \
  --secret-file ./credentials-velero

# Create backup
velero backup create prod-backup --include-namespaces=default,app-namespace

# List backups
velero backup get

# Restore from backup
velero restore create --from-backup prod-backup
```

### Backing Up Pulumi State

```bash
# Export stack state
pulumi stack export > stack-backup.json

# Import stack state
pulumi stack import < stack-backup.json

# For Pulumi Cloud, state is automatically backed up
# For local backend, backup the .pulumi directory
tar -czf pulumi-state-backup.tar.gz .pulumi/
```

### Disaster Recovery Plan

1. **Cluster Failure**:
   ```bash
   # Restore from Pulumi state
   pulumi up

   # Restore Kubernetes resources from Velero
   velero restore create --from-backup <latest-backup>
   ```

2. **DNS Failure**:
   ```bash
   # DNS zones are managed by Pulumi, re-deploy
   pulumi up --target urn:pulumi:prod::o-platform-infra-azure::azure-native:network:Zone::dns-zone-prod
   ```

3. **Complete Region Failure**:
   ```bash
   # Update region config
   pulumi config set azure-native:location eastus

   # Redeploy cluster
   pulumi up

   # Update DNS records to point to new cluster
   ```

## Cost Management

### Viewing Resource Costs

```bash
# Use Azure Cost Management
az consumption usage list \
  --start-date 2024-01-01 \
  --end-date 2024-01-31 \
  --query "[?contains(instanceName, 'aks')]"

# View cluster costs in portal
az aks show --resource-group prod-aks-rg --name aks-prod --query id
# Then navigate to Cost Analysis in Azure Portal
```

### Cost Optimization Tips

1. **Right-size VMs**: Monitor resource usage and adjust VM sizes
   ```bash
   kubectl top nodes
   # If nodes are underutilized, consider smaller VM sizes
   ```

2. **Scale down during off-hours**: Use NAP auto-scaling
   ```bash
   # NAP automatically scales based on workload
   # For additional control, adjust min node counts during off-hours
   ```

3. **Use ARM64 nodes**: Already configured (20% cost savings)

4. **Enable cluster auto-stop** (dev/test only):
   ```bash
   az aks stop --resource-group dev-aks-rg --name aks-dev
   az aks start --resource-group dev-aks-rg --name aks-dev
   ```

## Troubleshooting Common Issues

### Issue: Pod Stuck in Pending

```bash
# Check pod events
kubectl describe pod <pod-name> -n <namespace>

# Common causes:
# 1. Insufficient resources - NAP should auto-provision nodes
# 2. Node selector mismatch - check ARM64 requirements
# 3. Pending PVC - check storage provisioner

# Force NAP to provision nodes
kubectl get pod <pod-name> -n <namespace> -o yaml | grep -A 5 resources
```

### Issue: Ingress Not Routing Traffic

```bash
# Check ingress status
kubectl get ingress -n <namespace>
kubectl describe ingress <ingress-name> -n <namespace>

# Check ingress controller
kubectl get pods -n app-routing-system
kubectl logs -n app-routing-system -l app=nginx

# Verify DNS
nslookup <domain>

# Check service endpoints
kubectl get endpoints <service-name> -n <namespace>
```

### Issue: Certificate Not Issuing

```bash
# Check certificate status
kubectl describe certificate <cert-name> -n <namespace>

# Check cert-manager logs
kubectl logs -n cert-manager -l app=cert-manager

# Common issues:
# 1. DNS not resolving - verify A record
# 2. HTTP-01 challenge failing - check ingress
# 3. Rate limit hit - use staging issuer for testing

# View challenge status
kubectl get challenge -n <namespace>
kubectl describe challenge <challenge-name> -n <namespace>
```

### Issue: Workload Identity Not Working

```bash
# Verify OIDC issuer
pulumi stack output oidcIssuerUrl

# Check service account annotations
kubectl get sa <sa-name> -n <namespace> -o yaml

# Verify pod labels
kubectl get pod <pod-name> -n <namespace> -o yaml | grep -A 5 labels

# Test from pod
kubectl exec -it <pod-name> -n <namespace> -- az login --identity
```

## Maintenance Windows

### Planning Maintenance

1. **Schedule**: Plan maintenance during low-traffic periods
2. **Communication**: Notify stakeholders
3. **Backups**: Create backups before changes
4. **Rollback Plan**: Have rollback procedure ready

### Maintenance Checklist

```bash
# Pre-maintenance
□ Create backup: velero backup create pre-maintenance-backup
□ Export Pulumi state: pulumi stack export > pre-maintenance-state.json
□ Verify monitoring: kubectl get pods --all-namespaces
□ Document current state: kubectl get nodes -o wide > pre-maintenance-nodes.txt

# During maintenance
□ Apply changes: pulumi up
□ Monitor deployment: kubectl get events --watch
□ Verify services: kubectl get svc --all-namespaces
□ Test ingress: curl -v https://<domain>

# Post-maintenance
□ Verify all pods running: kubectl get pods --all-namespaces
□ Check certificates: kubectl get certificates --all-namespaces
□ Test critical services: curl -v https://<critical-service>
□ Monitor for 30 minutes: kubectl top nodes
□ Document changes: git commit -m "Maintenance: <description>"
```

## Emergency Procedures

### Cluster Unresponsive

```bash
# Check cluster status in Azure
az aks show --resource-group prod-aks-rg --name aks-prod --query provisioningState

# If cluster is failed, try repair
az aks update --resource-group prod-aks-rg --name aks-prod

# Last resort: redeploy
pulumi refresh
pulumi up
```

### Critical Security Vulnerability

```bash
# Immediately patch by updating Kubernetes version
pulumi config set kubernetesVersion "1.32.1"  # Patched version
pulumi up

# For node OS patching, trigger node image upgrade
az aks nodepool upgrade \
  --resource-group prod-aks-rg \
  --cluster-name aks-prod \
  --name system \
  --node-image-only
```

### Data Breach Response

1. Rotate all credentials immediately
2. Review audit logs: `kubectl get events --all-namespaces`
3. Isolate affected workloads
4. Notify security team
5. Follow incident response plan

## Compliance and Auditing

### Audit Logging

```bash
# Azure Activity Logs
az monitor activity-log list \
  --resource-group prod-aks-rg \
  --start-time 2024-01-01 \
  --end-time 2024-01-31

# Kubernetes Audit Logs (if enabled)
kubectl logs -n kube-system -l component=kube-apiserver
```

### Compliance Checks

```bash
# Check RBAC configuration
kubectl get clusterrolebindings -o json | \
  jq '.items[] | select(.subjects[].kind=="User")'

# Verify network policies
kubectl get networkpolicies --all-namespaces

# Check pod security standards
kubectl get pods --all-namespaces -o json | \
  jq '.items[] | select(.spec.securityContext.runAsNonRoot != true)'
```
