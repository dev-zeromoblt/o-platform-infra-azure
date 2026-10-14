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

// Flipping `paused` deletes or recreates the whole cluster, so only scripts/env.sh (which sets
// ALLOW_PAUSE_CHANGE=1) may do it. A plain `pulumi up` or CI run whose committed Pulumi.<env>.yaml
// disagrees with what is deployed fails here instead. The cluster's inputs wait on this check,
// so nothing is created first, and a failed program never reaches the delete phase.
const selfStack = new pulumi.StackReference(
    `${pulumi.getOrganization()}/${pulumi.getProject()}/${pulumi.getStack()}`,
);
const pauseGuard = selfStack.getOutput("isPaused").apply(deployed => {
    const deployedPaused = deployed === true;
    if (deployedPaused !== paused && process.env.ALLOW_PAUSE_CHANGE !== "1") {
        throw new Error(
            `${environment} is deployed with paused=${deployedPaused} but config says paused=${paused}. ` +
            `Use scripts/env.sh ${paused ? "pause" : "resume"} ${environment}, or commit ` +
            `Pulumi.${environment}.yaml with paused: "${deployedPaused}".`,
        );
    }
    return paused;
});

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
    const { cluster, kubeconfig: clusterKubeconfig, clusterName, oidcIssuerUrl: clusterOidcIssuerUrl, fqdn, roleAssignment } = createAksCluster({
        resourceGroupName: pulumi.all([pauseGuard, resourceGroup.name]).apply(([, rgName]) => rgName),
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

    // In-cluster resources below use deletedWith: cluster, so pausing deletes the cluster directly
    // instead of first removing them one by one (deleting the AKS-managed NodePools would make
    // Karpenter drain every node while finalizers and PDBs are still in place).

    // Install cert-manager with Let's Encrypt
    installCertManager({
        provider: k8sProvider,
        environment,
        email: certEmail,
        deletedWith: cluster,
    });

    // Patch AKS-managed Karpenter NodePools for cost optimization:
    //  - default: enable spot instances alongside on-demand
    //  - system-surge: switch amd64 → arm64
    patchKarpenterNodePools({
        provider: k8sProvider,
        environment,
        deletedWith: cluster,
    });

    return { clusterKubeconfig, clusterName, clusterOidcIssuerUrl, fqdn, ingressIP };
}

const clusterResources = paused ? undefined : deployCluster();
if (paused) {
    pulumi.log.warn(`⏸️  ${environment} is paused: AKS cluster is not deployed (ACR and DNS zone are kept)`);
}

// For prod environment, delegate the dev and beta subdomains to their own DNS zones.
// Each child zone must be <subdomain>.<prod domain> (e.g. beta.az.zeromoblt.com), otherwise the NS
// records point at a zone with the wrong apex and nothing resolves. No try/catch: a broken
// delegation should fail the deploy, not log a warning.
if (environment === "prod") {
    for (const subdomain of ["dev", "beta"]) {
        const childStack = new pulumi.StackReference(subdomain, {
            name: `${pulumi.getOrganization()}/o-platform-infra-azure/${subdomain}`,
        });
        const expectedDomain = `${subdomain}.${domain}`;
        const childNameServers = pulumi
            .all([childStack.requireOutput("domainName"), childStack.requireOutput("nameServers")])
            .apply(([childDomain, nameServers]) => {
                if (childDomain !== expectedDomain) {
                    throw new Error(`${subdomain} stack domain is ${childDomain}, expected ${expectedDomain}`);
                }
                return nameServers as string[];
            });

        createDnsDelegation({
            parentZoneName: dnsZone.name,
            parentResourceGroupName: dnsResourceGroup.name,
            subdomain, // relative to the prod zone (az.zeromoblt.com)
            nameServers: childNameServers,
            environment: environment,
        });
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
