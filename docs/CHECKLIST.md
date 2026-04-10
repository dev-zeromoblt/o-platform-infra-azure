# Pre-Deployment Checklist

Use this checklist before deploying each environment to ensure all prerequisites are met.

## Prerequisites

### Software Installation
- [ ] Azure CLI installed (`az --version`)
- [ ] Pulumi CLI installed (`pulumi version`)
- [ ] Node.js 20+ installed (`node --version`)
- [ ] kubectl installed (`kubectl version --client`)
- [ ] Git installed (`git --version`)

### Azure Configuration
- [ ] Logged into Azure (`az login`)
- [ ] Correct subscription selected (`az account show`)
- [ ] Sufficient permissions (Contributor or Owner role)
- [ ] Resource provider registered: `Microsoft.ContainerService`
- [ ] Resource provider registered: `Microsoft.Network`

### SSH Keys
- [ ] SSH key pair exists (`ls ~/.ssh/id_rsa.pub`)
- [ ] SSH public key accessible for Pulumi config

### Pulumi Setup
- [ ] Pulumi logged in (`pulumi whoami`)
- [ ] Pulumi organization/account verified
- [ ] Project directory accessible

### DNS Prerequisites
- [ ] Parent domain accessible (zeromoblt.com)
- [ ] Ability to add NS records to parent domain
- [ ] Understanding of DNS propagation time (5-30 minutes)

## Dev Environment Deployment

### Pre-Deployment
- [ ] Change to project directory
- [ ] Run `npm install`
- [ ] Initialize dev stack: `pulumi stack init dev`
- [ ] Set Azure location: `pulumi config set azure-native:location centralindia`
- [ ] Set environment: `pulumi config set o-platform-infra-azure:environment dev`
- [ ] Set Kubernetes version: `pulumi config set o-platform-infra-azure:kubernetesVersion "1.32"`
- [ ] Set VM size: `pulumi config set o-platform-infra-azure:systemPoolVmSize Standard_D2ps_v5`
- [ ] Set min nodes: `pulumi config set o-platform-infra-azure:systemPoolMinCount 1`
- [ ] Set max nodes: `pulumi config set o-platform-infra-azure:systemPoolMaxCount 3`
- [ ] Set domain: `pulumi config set o-platform-infra-azure:domain dev.az.zeromoblt.com`
- [ ] Set email: `pulumi config set o-platform-infra-azure:certManagerEmail admin@zeromoblt.com`
- [ ] Set SSH key: `pulumi config set o-platform-infra-azure:sshPubKey "$(cat ~/.ssh/id_rsa.pub)"`
- [ ] Review config: `pulumi config`

### Deployment
- [ ] Run preview: `pulumi preview`
- [ ] Review planned changes
- [ ] Verify resource counts and names
- [ ] Deploy: `pulumi up`
- [ ] Wait for completion (~10-15 minutes)
- [ ] Verify no errors in output

### Post-Deployment Verification
- [ ] Export kubeconfig: `pulumi stack output kubeconfig --show-secrets > kubeconfig-dev.yaml`
- [ ] Set KUBECONFIG: `export KUBECONFIG=$(pwd)/kubeconfig-dev.yaml`
- [ ] Verify cluster access: `kubectl cluster-info`
- [ ] Check nodes: `kubectl get nodes -o wide`
- [ ] Verify ARM64 architecture in node list
- [ ] Check system pods: `kubectl get pods -n kube-system`
- [ ] Verify ingress controller: `kubectl get svc -n app-routing-system`
- [ ] Check cert-manager: `kubectl get pods -n cert-manager`
- [ ] Get OIDC issuer: `pulumi stack output oidcIssuerUrl`
- [ ] Get ingress IP: `pulumi stack output ingressControllerIP`
- [ ] Get name servers: `pulumi stack output nameServers`

### DNS Configuration
- [ ] Copy name servers from output
- [ ] Access parent domain DNS management
- [ ] Add NS records for "dev.az" subdomain
- [ ] Point to Azure DNS name servers
- [ ] Wait for DNS propagation (5-30 minutes)
- [ ] Verify: `nslookup dev.az.zeromoblt.com`
- [ ] Verify: `dig dev.az.zeromoblt.com`

### Application Testing
- [ ] Deploy a test app (e.g., hello-world deployment with ingress)
- [ ] Wait for pod: `kubectl get pods -w`
- [ ] Check service: `kubectl get svc hello-world`
- [ ] Check ingress: `kubectl get ingress hello-world`
- [ ] Wait for certificate: `kubectl get certificate -w`
- [ ] Test HTTP: `curl http://hello.dev.az.zeromoblt.com`
- [ ] Test HTTPS: `curl https://hello.dev.az.zeromoblt.com`

### NAP Testing
- [ ] Deploy a resource-intensive workload to trigger NAP
- [ ] Watch nodes: `kubectl get nodes -w`
- [ ] Verify new nodes created
- [ ] Check node pools: `kubectl get nodepools`
- [ ] Delete test workload and observe scale-down after 10 minutes

### Documentation
- [ ] Document cluster details in team wiki
- [ ] Share kubeconfig with team (securely)
- [ ] Share OIDC issuer URL if needed
- [ ] Document DNS changes made
- [ ] Record deployment date and time

## Beta Environment Deployment

### Pre-Deployment
- [ ] Verify dev environment working correctly
- [ ] Initialize beta stack: `pulumi stack init beta`
- [ ] Set Azure location: `pulumi config set azure-native:location centralindia`
- [ ] Set environment: `pulumi config set o-platform-infra-azure:environment beta`
- [ ] Set Kubernetes version: `pulumi config set o-platform-infra-azure:kubernetesVersion "1.32"`
- [ ] Set VM size: `pulumi config set o-platform-infra-azure:systemPoolVmSize Standard_D4ps_v5`
- [ ] Set min nodes: `pulumi config set o-platform-infra-azure:systemPoolMinCount 2`
- [ ] Set max nodes: `pulumi config set o-platform-infra-azure:systemPoolMaxCount 6`
- [ ] Set domain: `pulumi config set o-platform-infra-azure:domain beta.az.zeromoblt.com`
- [ ] Set email: `pulumi config set o-platform-infra-azure:certManagerEmail admin@zeromoblt.com`
- [ ] Set SSH key: `pulumi config set o-platform-infra-azure:sshPubKey "$(cat ~/.ssh/id_rsa.pub)"`
- [ ] Review config: `pulumi config`

### Deployment
- [ ] Run preview: `pulumi preview`
- [ ] Review planned changes
- [ ] Deploy: `pulumi up`
- [ ] Wait for completion (~10-15 minutes)

### Post-Deployment Verification
- [ ] Export kubeconfig: `pulumi stack output kubeconfig --show-secrets > kubeconfig-beta.yaml`
- [ ] Verify cluster access
- [ ] Check nodes (should be 2+ ARM64 nodes)
- [ ] Verify all system components
- [ ] Configure DNS (beta.az subdomain)
- [ ] Test application deployment
- [ ] Document beta environment

## Prod Environment Deployment

### Pre-Deployment Review
- [ ] Dev environment fully tested
- [ ] Beta environment fully tested
- [ ] Team approval for prod deployment
- [ ] Backup/rollback plan documented
- [ ] Stakeholders notified of deployment

### Pre-Deployment
- [ ] Initialize prod stack: `pulumi stack init prod`
- [ ] Set Azure location: `pulumi config set azure-native:location centralindia`
- [ ] Set environment: `pulumi config set o-platform-infra-azure:environment prod`
- [ ] Set Kubernetes version: `pulumi config set o-platform-infra-azure:kubernetesVersion "1.32"`
- [ ] Set VM size: `pulumi config set o-platform-infra-azure:systemPoolVmSize Standard_D8ps_v5`
- [ ] Set min nodes: `pulumi config set o-platform-infra-azure:systemPoolMinCount 3`
- [ ] Set max nodes: `pulumi config set o-platform-infra-azure:systemPoolMaxCount 10`
- [ ] Set domain: `pulumi config set o-platform-infra-azure:domain az.zeromoblt.com`
- [ ] Set email: `pulumi config set o-platform-infra-azure:certManagerEmail admin@zeromoblt.com`
- [ ] Set SSH key: `pulumi config set o-platform-infra-azure:sshPubKey "$(cat ~/.ssh/id_rsa.pub)"`
- [ ] Review config: `pulumi config`

### Deployment
- [ ] Run preview: `pulumi preview`
- [ ] Review ALL planned changes carefully
- [ ] Get second team member review
- [ ] Deploy: `pulumi up`
- [ ] Monitor deployment progress
- [ ] Wait for completion (~10-15 minutes)

### Post-Deployment Verification
- [ ] Export kubeconfig securely
- [ ] Verify cluster access
- [ ] Check nodes (should be 3+ ARM64 nodes)
- [ ] Verify all system components healthy
- [ ] Configure DNS (root domain or "az" subdomain)
- [ ] Test application deployment
- [ ] Verify TLS certificates working
- [ ] Load test if applicable
- [ ] Monitor for 24 hours

### Production Readiness
- [ ] Monitoring enabled
- [ ] Alerting configured
- [ ] Backup strategy implemented
- [ ] Disaster recovery tested
- [ ] Runbook documented
- [ ] On-call rotation established
- [ ] SLA documented
- [ ] Cost monitoring enabled

## Post-Deployment Activities

### All Environments
- [ ] Save kubeconfig files securely (password manager, vault)
- [ ] Export stack state: `pulumi stack export > stack-backup.json`
- [ ] Commit any local changes to git
- [ ] Update team documentation
- [ ] Add calendar reminders for certificate renewals (if manual)
- [ ] Schedule first maintenance window
- [ ] Plan capacity review (1 month out)

### Security Hardening
- [ ] Review RBAC permissions
- [ ] Enable audit logging
- [ ] Configure network policies
- [ ] Review pod security standards
- [ ] Enable Azure Policy if required
- [ ] Configure Azure Monitor
- [ ] Set up Log Analytics workspace

### Cost Management
- [ ] Tag all resources appropriately
- [ ] Set up cost alerts
- [ ] Enable Azure Cost Management
- [ ] Review reserved instance opportunities
- [ ] Monitor NAP node provisioning patterns
- [ ] Optimize VM sizes after 1 week of metrics

### Operational Readiness
- [ ] Document cluster access procedures
- [ ] Create runbooks for common operations
- [ ] Test scaling procedures
- [ ] Test upgrade procedures in dev/beta
- [ ] Document rollback procedures
- [ ] Create incident response plan
- [ ] Schedule monthly operations review

## Troubleshooting Checklist

If deployment fails:
- [ ] Check Azure subscription status
- [ ] Verify sufficient quota for VM sizes
- [ ] Check Azure service health
- [ ] Review Pulumi error messages
- [ ] Check Azure activity log: `az monitor activity-log list`
- [ ] Verify DNS zone doesn't already exist (name conflict)
- [ ] Check RBAC permissions
- [ ] Review Pulumi state: `pulumi stack export`
- [ ] Try `pulumi refresh` to sync state
- [ ] Check network connectivity to Azure

If cluster access fails:
- [ ] Regenerate kubeconfig
- [ ] Verify Azure credentials
- [ ] Check cluster provisioning state in Azure Portal
- [ ] Review firewall/proxy settings
- [ ] Verify kubectl version compatibility

If DNS doesn't resolve:
- [ ] Verify NS records added to parent domain
- [ ] Wait for DNS propagation (up to 48 hours worst case)
- [ ] Check DNS zone in Azure Portal
- [ ] Verify A records created
- [ ] Test with `dig` and `nslookup`

## Success Criteria

Environment is successfully deployed when:
- [ ] Cluster accessible via kubectl
- [ ] All nodes showing Ready status
- [ ] All system pods running
- [ ] Ingress controller has external IP
- [ ] Cert-manager pods running
- [ ] DNS resolves correctly
- [ ] Test application accessible via HTTPS
- [ ] TLS certificate valid
- [ ] NAP successfully provisions nodes
- [ ] Stack outputs all available
- [ ] No errors in Azure activity log
- [ ] Monitoring data flowing

## Final Sign-Off

- [ ] Dev environment: Deployed by _____________ on _______
- [ ] Beta environment: Deployed by _____________ on _______
- [ ] Prod environment: Deployed by _____________ on _______

- [ ] Team lead approval: _____________
- [ ] Operations team notified: Yes/No
- [ ] Documentation updated: Yes/No
- [ ] Stakeholders informed: Yes/No

---

**Notes:**
- Keep this checklist updated as procedures evolve
- Use issue tracker to document any deviations
- Review and update quarterly
- Share lessons learned with team
