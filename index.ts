import * as pulumi from "@pulumi/pulumi";
import * as azurenative from "@pulumi/azure-native";
import { createAksCluster } from "./deployments/cluster";
import { createDnsZone, createDnsARecord } from "./deployments/dns-zones";
import { getIngressController } from "./deployments/ingress-controller";
import { installCertManager } from "./deployments/cert-manager";

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
const certManagerEmail = config.get("certManagerEmail") || `admin@${domain}`;

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
const { cluster, kubeconfig, clusterName, oidcIssuerUrl, fqdn } = createAksCluster({
    resourceGroupName: resourceGroup.name,
    environment,
    kubernetesVersion,
    systemPoolVmSize,
    systemPoolMinCount,
    systemPoolMaxCount,
    sshPubKey,
});

// Get managed ingress controller IP
const { provider: k8sProvider, ip: ingressIP } = getIngressController({
    kubeconfig,
    environment,
});

// Create DNS zone
const { zone: dnsZone, nameServers, resourceGroup: dnsResourceGroup } = createDnsZone({
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

// Install cert-manager with Let's Encrypt
const { chart: certManagerChart, clusterIssuerProd, clusterIssuerStaging } = installCertManager({
    provider: k8sProvider,
    environment,
    email: certManagerEmail,
});

// Export stack outputs
export const outputs = {
    // Cluster information
    resourceGroupName: resourceGroup.name,
    clusterName: clusterName,
    clusterFqdn: fqdn,
    kubeconfig: pulumi.secret(kubeconfig),

    // OIDC for workload identity
    oidcIssuerUrl: oidcIssuerUrl,

    // Ingress
    ingressControllerIP: ingressIP,

    // DNS
    domain: domain,
    dnsZoneName: dnsZone.name,
    dnsResourceGroupName: dnsResourceGroup.name,
    nameServers: nameServers,

    // Cert-manager
    certManagerEmail: certManagerEmail,

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
