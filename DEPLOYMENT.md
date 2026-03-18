# Deployment Guide

## Step-by-Step Deployment Process

### 1. Prerequisites Setup

#### Install Required Tools

```bash
# Install Azure CLI
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# Install Pulumi
curl -fsSL https://get.pulumi.com | sh

# Install Node.js (via nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
nvm use 20
```

#### Configure Azure

```bash
# Login to Azure
az login

# List subscriptions
az account list --output table

# Set active subscription
az account set --subscription "Your Subscription Name"

# Verify active subscription
az account show
```

#### Generate SSH Key (if needed)

```bash
ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa -N ""
```

### 2. Project Initialization

```bash
# Clone or navigate to project
cd /Users/zeroman/ovalabs/o-platform-infra-azure

# Install dependencies
npm install

# Login to Pulumi (use local backend or Pulumi Cloud)
pulumi login  # For Pulumi Cloud
# OR
pulumi login --local  # For local state management
```

### 3. Deploy Dev Environment

```bash
# Initialize dev stack
pulumi stack init dev

# Configure stack
pulumi config set azure-native:location centralindia
pulumi config set o-platform-infra-azure:environment dev
pulumi config set o-platform-infra-azure:kubernetesVersion "1.32"
pulumi config set o-platform-infra-azure:systemPoolVmSize Standard_D2ps_v5
pulumi config set o-platform-infra-azure:systemPoolMinCount 1
pulumi config set o-platform-infra-azure:systemPoolMaxCount 3
pulumi config set o-platform-infra-azure:domain dev.az.zeromoblt.com
pulumi config set o-platform-infra-azure:certManagerEmail admin@zeromoblt.com
pulumi config set o-platform-infra-azure:sshPubKey "$(cat ~/.ssh/id_rsa.pub)"

# Preview deployment
pulumi preview

# Deploy infrastructure
pulumi up

# Deployment will take approximately 10-15 minutes
```

### 4. Verify Dev Deployment

```bash
# Export kubeconfig
pulumi stack output kubeconfig --show-secrets > kubeconfig-dev.yaml
export KUBECONFIG=$(pwd)/kubeconfig-dev.yaml

# Verify cluster access
kubectl cluster-info

# Check nodes (should show ARM64 architecture)
kubectl get nodes -o wide

# Verify system pods
kubectl get pods -n kube-system

# Check ingress controller
kubectl get svc -n app-routing-system

# Check cert-manager
kubectl get pods -n cert-manager

# Verify OIDC issuer
pulumi stack output oidcIssuerUrl

# Get DNS name servers for delegation
pulumi stack output nameServers
```

### 5. Configure DNS Delegation

After deployment, you need to delegate your subdomain to Azure DNS:

```bash
# Get name servers
pulumi stack output nameServers

# Add NS records to parent domain (zeromoblt.com) pointing to Azure DNS name servers
# Example for dev.az.zeromoblt.com:
# - Go to your domain registrar for zeromoblt.com
# - Add NS records for subdomain "dev.az" pointing to the name servers above

# Wait for DNS propagation (5-30 minutes)
# Verify DNS resolution
nslookup dev.az.zeromoblt.com
dig dev.az.zeromoblt.com
```

### 6. Deploy Beta Environment

```bash
# Select or create beta stack
pulumi stack init beta

# Configure stack
pulumi config set azure-native:location centralindia
pulumi config set o-platform-infra-azure:environment beta
pulumi config set o-platform-infra-azure:kubernetesVersion "1.32"
pulumi config set o-platform-infra-azure:systemPoolVmSize Standard_D4ps_v5
pulumi config set o-platform-infra-azure:systemPoolMinCount 2
pulumi config set o-platform-infra-azure:systemPoolMaxCount 6
pulumi config set o-platform-infra-azure:domain beta.az.zeromoblt.com
pulumi config set o-platform-infra-azure:certManagerEmail admin@zeromoblt.com
pulumi config set o-platform-infra-azure:sshPubKey "$(cat ~/.ssh/id_rsa.pub)"

# Deploy
pulumi up
```

### 7. Deploy Prod Environment

```bash
# Select or create prod stack
pulumi stack init prod

# Configure stack
pulumi config set azure-native:location centralindia
pulumi config set o-platform-infra-azure:environment prod
pulumi config set o-platform-infra-azure:kubernetesVersion "1.32"
pulumi config set o-platform-infra-azure:systemPoolVmSize Standard_D8ps_v5
pulumi config set o-platform-infra-azure:systemPoolMinCount 3
pulumi config set o-platform-infra-azure:systemPoolMaxCount 10
pulumi config set o-platform-infra-azure:domain az.zeromoblt.com
pulumi config set o-platform-infra-azure:certManagerEmail admin@zeromoblt.com
pulumi config set o-platform-infra-azure:sshPubKey "$(cat ~/.ssh/id_rsa.pub)"

# Deploy
pulumi up
```

## Testing Ingress and TLS

### Deploy Test Application

Create a test application to verify ingress and TLS:

```yaml
# test-app.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-world
  namespace: default
spec:
  replicas: 2
  selector:
    matchLabels:
      app: hello-world
  template:
    metadata:
      labels:
        app: hello-world
    spec:
      nodeSelector:
        kubernetes.io/arch: arm64
      containers:
      - name: hello-world
        image: mcr.microsoft.com/azuredocs/aks-helloworld:v1
        ports:
        - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: hello-world
  namespace: default
spec:
  selector:
    app: hello-world
  ports:
  - port: 80
    targetPort: 80
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: hello-world
  namespace: default
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-staging  # Use staging for testing
spec:
  ingressClassName: webapprouting.kubernetes.azure.com
  tls:
  - hosts:
    - hello.dev.az.zeromoblt.com
    secretName: hello-world-tls
  rules:
  - host: hello.dev.az.zeromoblt.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: hello-world
            port:
              number: 80
```

Deploy and test:

```bash
# Deploy test app
kubectl apply -f test-app.yaml

# Wait for certificate to be issued
kubectl get certificate -n default
kubectl describe certificate hello-world-tls -n default

# Test access
curl https://hello.dev.az.zeromoblt.com

# Switch to production issuer once verified
kubectl patch ingress hello-world -n default \
  -p '{"metadata":{"annotations":{"cert-manager.io/cluster-issuer":"letsencrypt-prod"}}}'
```

## Node Auto-Provisioning (NAP) Testing

NAP automatically creates nodes based on workload demands. Test it:

```yaml
# nap-test.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nap-test
spec:
  replicas: 5
  selector:
    matchLabels:
      app: nap-test
  template:
    metadata:
      labels:
        app: nap-test
    spec:
      nodeSelector:
        kubernetes.io/arch: arm64
      containers:
      - name: nginx
        image: nginx:alpine
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
```

Deploy and observe:

```bash
# Deploy workload
kubectl apply -f nap-test.yaml

# Watch nodes being provisioned
kubectl get nodes -w

# Check node pools
kubectl get nodepools

# Cleanup
kubectl delete -f nap-test.yaml

# Watch nodes being scaled down (after 10 minutes)
kubectl get nodes -w
```

## AWS Identity Federation Setup

Configure AWS IAM for workload identity:

### 1. Get OIDC Issuer URL

```bash
pulumi stack select prod
OIDC_ISSUER=$(pulumi stack output oidcIssuerUrl)
echo $OIDC_ISSUER
```

### 2. Create AWS IAM OIDC Provider

```bash
# Extract issuer without https://
ISSUER_HOSTPATH=$(echo $OIDC_ISSUER | sed 's/https:\/\///')

# Get thumbprint (required by AWS)
THUMBPRINT=$(echo | openssl s_client -servername $ISSUER_HOSTPATH -showcerts -connect $ISSUER_HOSTPATH:443 2>&- | openssl x509 -fingerprint -noout | sed 's/://g' | awk -F= '{print tolower($2)}')

# Create OIDC provider in AWS
aws iam create-open-id-connect-provider \
  --url $OIDC_ISSUER \
  --client-id-list api://AzureADTokenExchange \
  --thumbprint-list $THUMBPRINT
```

### 3. Create IAM Role with Trust Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/OIDC_ISSUER_HOST"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "OIDC_ISSUER_HOST:sub": "system:serviceaccount:NAMESPACE:SERVICE_ACCOUNT_NAME"
        }
      }
    }
  ]
}
```

## Monitoring and Operations

### View Cluster Metrics

```bash
# Azure Portal
az aks show --resource-group <rg-name> --name <cluster-name>

# Or use kubectl
kubectl top nodes
kubectl top pods --all-namespaces
```

### Update Kubernetes Version

```bash
# List available versions
az aks get-versions --location centralindia --output table

# Update config
pulumi config set kubernetesVersion "1.33"

# Apply update
pulumi up
```

### Scale Node Pool

```bash
# Update min/max counts
pulumi config set systemPoolMinCount 2
pulumi config set systemPoolMaxCount 5

# Apply changes
pulumi up
```

## Troubleshooting

### Cluster Not Accessible

```bash
# Regenerate kubeconfig
pulumi stack output kubeconfig --show-secrets > kubeconfig.yaml

# Verify Azure credentials
az account show

# Check cluster status
az aks show --resource-group <rg-name> --name <cluster-name> --query provisioningState
```

### Ingress Not Getting IP

```bash
# Check ingress controller pods
kubectl get pods -n app-routing-system

# Check service
kubectl get svc -n app-routing-system

# View logs
kubectl logs -n app-routing-system -l app=nginx
```

### Certificate Issues

```bash
# Check cert-manager pods
kubectl get pods -n cert-manager

# Check certificate status
kubectl get certificate --all-namespaces
kubectl describe certificate <cert-name> -n <namespace>

# Check cert-manager logs
kubectl logs -n cert-manager -l app=cert-manager
```

### DNS Not Resolving

```bash
# Verify NS records are set correctly
dig NS dev.az.zeromoblt.com

# Check Azure DNS zone
az network dns zone show --resource-group dns-rg-dev --name dev.az.zeromoblt.com

# Check A records
az network dns record-set a list --resource-group dns-rg-dev --zone-name dev.az.zeromoblt.com
```

## Cleanup

### Destroy Single Environment

```bash
pulumi stack select dev
pulumi destroy
```

### Destroy All Environments

```bash
# Destroy in reverse order (prod -> beta -> dev)
pulumi stack select prod
pulumi destroy

pulumi stack select beta
pulumi destroy

pulumi stack select dev
pulumi destroy
```

### Remove Stacks

```bash
pulumi stack rm prod
pulumi stack rm beta
pulumi stack rm dev
```
