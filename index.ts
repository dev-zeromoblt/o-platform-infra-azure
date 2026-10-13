import * as pulumi from "@pulumi/pulumi";
import * as azurenative from "@pulumi/azure-native";
import { createAksCluster } from "./deployments/cluster";
import { createDnsZone, createDnsARecord } from "./deployments/dns-zones";
import { getIngressController } from "./deployments/ingress-controller";
import { installCertManager } from "./deployments/cert-manager";
import { createDnsDelegation } from "./deployments/dns-delegation";
import { createAcr } from "./deployments/acr";
import { patchKarpenterNodePools } from "./deployments/karpenter-patches";

// Get configuration
const config = new pulumi.Config();
const azureConfig = new pulumi.Config("azure-native");

const environment = config.require("environment");
const kubernetesVersion = config.require("kubernetesVersion");
const systemPoolVmSize = config.require("systemPoolVmSize");
const systemPoolMinCount = config.requireNumber("systemPoolMinCount");
const systemPoolMaxCount = config.requireNumber("systemPoolMaxCount");
const sshPubKey = config.require("sshPubKey");
const domain = config.require("domain");
const location = azureConfig.require("location");
const certEmail = config.get("certManagerEmail") || `admin@${domain}`;
const adminUserObjectId = config.get("adminUserObjectId"); // Optional: User/SP object ID for Azure RBAC
// Paused: remove the AKS cluster and everything in it (control plane, VMSS nodes, NAT gateway,
// load balancer, PVC disks) while keeping the resource group, ACR and DNS zone, so the zone's
// name servers (delegated from prod) stay the same. Set back to false and `pulumi up` to resume.
const paused = config.getBoolean("paused") ?? false;
if (paused && environment === "prod") {
    throw new Error("paused=true is not allowed for prod");
}

// Create main resource group for AKS
const resourceGroup = new azurenative.resources.ResourceGroup(`${environment}-aks-rg`, {
    resourceGroupName: `${environment}-aks-rg`,
    location: location,
    tags: {
        environment: environment,
        managedBy: "pulumi",
    },
});

// Create Azure Container Registry
const acr = createAcr({
    resourceGroupName: resourceGroup.name,
    environment,
    location,
});

// Create DNS zone
const { zone: dnsZone, nameServers: dnsNameServers, resourceGroup: dnsResourceGroup } = createDnsZone({
    environment,
    domain,
    location,
});

// Cluster and everything that runs in it; skipped entirely while paused
function deployCluster() {
    // Create AKS Automatic cluster
    const { kubeconfig: clusterKubeconfig, clusterName, oidcIssuerUrl: clusterOidcIssuerUrl, fqdn, roleAssignment } = createAksCluster({
        resourceGroupName: resourceGroup.name,
        environment,
        kubernetesVersion,
        systemPoolVmSize,
        systemPoolMinCount,
        systemPoolMaxCount,
        sshPubKey,
        adminUserObjectId: adminUserObjectId,
    });

    // Get managed ingress controller IP
    // Note: If roleAssignment exists, Kubernetes provider should depend on it
    const { provider: k8sProvider, ip: ingressIP } = getIngressController({
        kubeconfig: clusterKubeconfig,
        environment,
        dependsOn: roleAssignment ? [roleAssignment] : [],
    });

    // Create DNS A record for root domain pointing to ingress IP
    createDnsARecord(dnsZone.name, dnsResourceGroup.name, "@", ingressIP, environment);

    // Create wildcard A record for subdomains
    createDnsARecord(dnsZone.name, dnsResourceGroup.name, "*", ingressIP, environment);

    // Install cert-manager with Let's Encrypt
    installCertManager({
        provider: k8sProvider,
        environment,
        email: certEmail,
    });

    // Patch AKS-managed Karpenter NodePools for cost optimization:
    //  - default: enable spot instances alongside on-demand
    //  - system-surge: switch amd64 → arm64
    patchKarpenterNodePools({
        provider: k8sProvider,
        environment,
    });

    return { clusterKubeconfig, clusterName, clusterOidcIssuerUrl, fqdn, ingressIP };
}

const clusterResources = paused ? undefined : deployCluster();
if (paused) {
    pulumi.log.warn(`⏸️  ${environment} is paused: AKS cluster is not deployed (ACR and DNS zone are kept)`);
}

// For prod environment, create DNS delegation for dev subdomain
let devDelegation: azurenative.network.RecordSet | undefined;
let prodDelegation: azurenative.network.RecordSet | undefined;
if (environment === "prod") {
    try {
        // Reference the dev stack to get its DNS name servers
        const devStack = new pulumi.StackReference("dev", {
            name: `${pulumi.getOrganization()}/o-platform-infra-azure/dev`,
        });

        const devNameServers = devStack.getOutput("nameServers");

        // Create NS records to delegate dev.az.zeromoblt.com to dev's DNS zone
        devDelegation = createDnsDelegation({
            parentZoneName: dnsZone.name,
            parentResourceGroupName: dnsResourceGroup.name,
            subdomain: "dev", // Just "dev" because we're in az.zeromoblt.com zone
            nameServers: devNameServers,
            environment: environment,
        });

        pulumi.log.info("✅ Created DNS delegation for dev.az subdomain");
    } catch (error) {
        pulumi.log.warn(`⚠️  Could not create DNS delegation for dev: ${error}`);
    }

    try {
        // Reference the beta stack to get its DNS name servers
        const betaStack = new pulumi.StackReference("beta", {
            name: `${pulumi.getOrganization()}/o-platform-infra-azure/beta`,
        });

        const betaNameServers = betaStack.getOutput("nameServers");

        // Create NS records to delegate beta.az.zeromoblt.com to beta's DNS zone
        devDelegation = createDnsDelegation({
            parentZoneName: dnsZone.name,
            parentResourceGroupName: dnsResourceGroup.name,
            subdomain: "beta", // Just "beta" because we're in az.zeromoblt.com zone
            nameServers: betaNameServers,
            environment: environment,
        });

        pulumi.log.info("✅ Created DNS delegation for beta.az subdomain");
    } catch (error) {
        pulumi.log.warn(`⚠️  Could not create DNS delegation for beta: ${error}`);
    }
}

// Export stack outputs (cluster outputs are absent while paused)
export const outputs = {
    paused: paused,

    // Cluster information
    resourceGroupName: resourceGroup.name,
    clusterName: clusterResources?.clusterName,
    clusterFqdn: clusterResources?.fqdn,
    kubeconfig: clusterResources ? pulumi.secret(clusterResources.clusterKubeconfig) : undefined,

    // OIDC for workload identity
    oidcIssuerUrl: clusterResources?.clusterOidcIssuerUrl,

    // Ingress
    ingressControllerIP: clusterResources?.ingressIP,

    // DNS
    domain: domain,
    dnsZoneName: dnsZone.name,
    dnsResourceGroupName: dnsResourceGroup.name,
    nameServers: dnsNameServers,

    // Cert-manager
    certManagerEmail: certEmail,

    // ACR (Azure Container Registry)
    acrLoginServer: acr.loginServer,
    acrUsername: acr.username,
    acrPassword: pulumi.secret(acr.password),

    // Environment
    environment: environment,
    location: location,
};

// Export individual outputs for easier access
export const isPaused = outputs.paused;
export const resourceGroupName = outputs.resourceGroupName;
export const aksClusterName = outputs.clusterName;
export const aksClusterFqdn = outputs.clusterFqdn;
export const kubeconfig = outputs.kubeconfig;
export const oidcIssuerUrl = outputs.oidcIssuerUrl;
export const ingressControllerIP = outputs.ingressControllerIP;
export const domainName = outputs.domain;
export const dnsZoneName = outputs.dnsZoneName;
export const dnsResourceGroupName = outputs.dnsResourceGroupName;
export const nameServers = outputs.nameServers;
export const certManagerEmail = outputs.certManagerEmail;
export const acrLoginServer = outputs.acrLoginServer;
export const acrUsername = outputs.acrUsername;
export const acrPassword = outputs.acrPassword;
