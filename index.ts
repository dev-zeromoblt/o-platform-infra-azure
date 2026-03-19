import * as pulumi from "@pulumi/pulumi";
import * as azurenative from "@pulumi/azure-native";
import { createAksCluster } from "./deployments/cluster";
import { createDnsZone, createDnsARecord } from "./deployments/dns-zones";
import { getIngressController } from "./deployments/ingress-controller";
import { installCertManager } from "./deployments/cert-manager";
import { createDnsDelegation } from "./deployments/dns-delegation";
// Removed: Karpenter NodePools - AKS Automatic handles workload provisioning

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

// Create main resource group for AKS
const resourceGroup = new azurenative.resources.ResourceGroup(`${environment}-aks-rg`, {
    resourceGroupName: `${environment}-aks-rg`,
    location: location,
    tags: {
        environment: environment,
        managedBy: "pulumi",
    },
});

// Create AKS Automatic cluster
const { cluster, kubeconfig: clusterKubeconfig, clusterName, oidcIssuerUrl: clusterOidcIssuerUrl, fqdn } = createAksCluster({
    resourceGroupName: resourceGroup.name,
    environment,
    kubernetesVersion,
    systemPoolVmSize,
    systemPoolMinCount,
    systemPoolMaxCount,
    sshPubKey,
    adminUserObjectId: "1610c587-f138-4532-a530-6dcf885513c7",
});

// Get managed ingress controller IP
const { provider: k8sProvider, ip: ingressIP } = getIngressController({
    kubeconfig: clusterKubeconfig,
    environment,
});

// Create DNS zone
const { zone: dnsZone, nameServers: dnsNameServers, resourceGroup: dnsResourceGroup } = createDnsZone({
    environment,
    domain,
    location,
});

// Create DNS A record for root domain pointing to ingress IP
const rootARecord = createDnsARecord(
    dnsZone.name,
    dnsResourceGroup.name,
    "@",
    ingressIP,
    environment
);

// Create wildcard A record for subdomains
const wildcardARecord = createDnsARecord(
    dnsZone.name,
    dnsResourceGroup.name,
    "*",
    ingressIP,
    environment
);

// For prod environment, create DNS delegation for dev subdomain
let devDelegation: azurenative.network.RecordSet | undefined;
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
}

// Install cert-manager with Let's Encrypt
const { release: certManagerRelease, clusterIssuerProd, clusterIssuerStaging } = installCertManager({
    provider: k8sProvider,
    environment,
    email: certEmail,
});

// Removed: Karpenter NodePools - AKS Automatic handles workload provisioning automatically

// Export stack outputs
export const outputs = {
    // Cluster information
    resourceGroupName: resourceGroup.name,
    clusterName: clusterName,
    clusterFqdn: fqdn,
    kubeconfig: pulumi.secret(clusterKubeconfig),

    // OIDC for workload identity
    oidcIssuerUrl: clusterOidcIssuerUrl,

    // Ingress
    ingressControllerIP: ingressIP,

    // DNS
    domain: domain,
    dnsZoneName: dnsZone.name,
    dnsResourceGroupName: dnsResourceGroup.name,
    nameServers: dnsNameServers,

    // Cert-manager
    certManagerEmail: certEmail,

    // Environment
    environment: environment,
    location: location,
};

// Export individual outputs for easier access
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
