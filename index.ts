import * as pulumi from "@pulumi/pulumi";
import * as azurenative from "@pulumi/azure-native";
import { createAksCluster } from "./deployments/cluster";
import { createDnsZone, createDnsARecord } from "./deployments/dns-zones";
import { getIngressController } from "./deployments/ingress-controller";
import { installCertManager } from "./deployments/cert-manager";
import { createDnsDelegation } from "./deployments/dns-delegation";
import { createAcr } from "./deployments/acr";
import { patchKarpenterNodePools } from "./deployments/karpenter-patches";
import { createHedgeDocDatabase } from "./deployments/hedgedoc-database";
import { createHedgeDoc } from "./deployments/hedgedoc";
import { createHedgeDocIngress } from "./deployments/hedgedoc-ingress";

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

// Create AKS Automatic cluster
const { cluster, kubeconfig: clusterKubeconfig, clusterName, oidcIssuerUrl: clusterOidcIssuerUrl, fqdn, roleAssignment } = createAksCluster({
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

// Install cert-manager with Let's Encrypt
const { release: certManagerRelease, clusterIssuerProd, clusterIssuerStaging } = installCertManager({
    provider: k8sProvider,
    environment,
    email: certEmail,
});

// Patch AKS-managed Karpenter NodePools for cost optimization:
//  - default: enable spot instances alongside on-demand
//  - system-surge: switch amd64 → arm64
const karpenterPatches = patchKarpenterNodePools({
    provider: k8sProvider,
    environment,
});

// ---------------------------------------------------------------------------
// HedgeDoc (BALL-46) — internal collaborative markdown notes.
// Opt-in per stack so enabling it on dev does not implicitly touch beta/prod.
// ---------------------------------------------------------------------------
const hedgedocEnabled = config.getBoolean("hedgedocEnabled") || false;

let hedgedocUrl: pulumi.Output<string> | string | undefined;
let hedgedocDbFqdn: pulumi.Output<string> | undefined;
let hedgedocNamespace: pulumi.Output<string> | undefined;

if (hedgedocEnabled) {
    const hedgedocDomain = config.require("hedgedocDomain");
    if (!hedgedocDomain.endsWith(`.${domain}`)) {
        throw new Error(
            `hedgedocDomain (${hedgedocDomain}) must be a subdomain of the stack domain (${domain})`
        );
    }
    // "docs.dev.az.zeromoblt.com" within zone "dev.az.zeromoblt.com" -> record "docs"
    const hedgedocRecordName = hedgedocDomain.slice(0, -(domain.length + 1));

    // The cluster egresses through a managed NAT gateway, so this is a single
    // stable address. Find it with:
    //   az network public-ip list -g <node-rg> --query "[].ipAddress"
    // A private endpoint is not an option here — see deployments/hedgedoc-database.ts.
    const hedgedocEgressIps = config.requireObject<string[]>("hedgedocAllowedEgressIps");

    const hedgedocDb = createHedgeDocDatabase({
        environment,
        location,
        allowedEgressIps: hedgedocEgressIps,
        administratorLogin: config.get("hedgedocDbAdminUser") || "hedgedocadmin",
        administratorPassword: config.requireSecret("hedgedocDbAdminPassword"),
        databaseName: config.get("hedgedocDbName") || "hedgedoc",
        postgresVersion: config.get("hedgedocPgVersion") || "16",
        skuName: config.get("hedgedocPgSku") || "Standard_B2s",
        skuTier: config.get("hedgedocPgTier") || "Burstable",
        storageSizeGB: config.getNumber("hedgedocPgStorageGB") || 32,
        backupRetentionDays: config.getNumber("hedgedocPgBackupDays") || 14,
        highAvailability: config.getBoolean("hedgedocPgHighAvailability") || false,
    });

    const hedgedoc = createHedgeDoc({
        provider: k8sProvider,
        environment,
        domain: hedgedocDomain,
        image: config.get("hedgedocImage") || "quay.io/hedgedoc/hedgedoc:1.11.1",
        dbConnectionString: hedgedocDb.connectionString,
        sessionSecret: config.requireSecret("hedgedocSessionSecret"),
        googleClientId: config.getSecret("hedgedocGoogleClientId"),
        googleClientSecret: config.getSecret("hedgedocGoogleClientSecret"),
        googleHostedDomain: config.get("hedgedocGoogleHostedDomain") || "zeromoblt.com",
        uploadsStorageSize: config.get("hedgedocUploadsSize") || "20Gi",
        uploadsStorageClass: config.get("hedgedocUploadsStorageClass") || "managed-csi",
        cpuRequest: config.get("hedgedocCpuRequest") || "500m",
        cpuLimit: config.get("hedgedocCpuLimit") || "2",
        memoryRequest: config.get("hedgedocMemoryRequest") || "768Mi",
        memoryLimit: config.get("hedgedocMemoryLimit") || "2Gi",
        // The pod cannot connect until the database exists and the firewall admits
        // the cluster's egress address.
        dependsOn: [hedgedocDb.database, ...hedgedocDb.firewallRules],
    });

    const hedgedocIngress = createHedgeDocIngress({
        provider: k8sProvider,
        environment,
        domain: hedgedocDomain,
        recordName: hedgedocRecordName,
        namespace: hedgedoc.namespaceName,
        serviceName: hedgedoc.serviceName,
        servicePort: hedgedoc.servicePort,
        ingressIP: ingressIP,
        dnsZoneName: dnsZone.name,
        dnsResourceGroupName: dnsResourceGroup.name,
        clusterIssuer: "letsencrypt-prod",
        dependsOn: [certManagerRelease, hedgedoc.service],
    });

    hedgedocUrl = hedgedocIngress.url;
    hedgedocDbFqdn = hedgedocDb.fqdn;
    hedgedocNamespace = hedgedoc.namespaceName;
}

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

    // ACR (Azure Container Registry)
    acrLoginServer: acr.loginServer,
    acrUsername: acr.username,
    acrPassword: pulumi.secret(acr.password),

    // HedgeDoc (undefined when hedgedocEnabled is false)
    hedgedocUrl: hedgedocUrl,
    hedgedocDbFqdn: hedgedocDbFqdn,
    hedgedocNamespace: hedgedocNamespace,

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
export const acrLoginServer = outputs.acrLoginServer;
export const acrUsername = outputs.acrUsername;
export const acrPassword = outputs.acrPassword;
export const hedgedocSiteUrl = outputs.hedgedocUrl;
export const hedgedocDatabaseFqdn = outputs.hedgedocDbFqdn;
export const hedgedocK8sNamespace = outputs.hedgedocNamespace;
