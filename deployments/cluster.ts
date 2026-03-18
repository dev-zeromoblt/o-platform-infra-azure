import * as pulumi from "@pulumi/pulumi";
import * as azurenative from "@pulumi/azure-native";

export interface ClusterConfig {
    resourceGroupName: string;
    environment: string;
    kubernetesVersion: string;
    systemPoolVmSize: string;
    systemPoolMinCount: number;
    systemPoolMaxCount: number;
    sshPubKey: string;
}

export function createAksCluster(config: ClusterConfig) {
    const clusterName = `aks-${config.environment}`;

    // Create AKS Automatic cluster with Standard tier
    const managedCluster = new azurenative.containerservice.ManagedCluster(clusterName, {
        resourceGroupName: config.resourceGroupName,
        location: pulumi.output(azurenative.resources.getResourceGroup({ resourceGroupName: config.resourceGroupName })).location,

        // AKS Automatic requires Standard tier
        sku: {
            name: "Automatic",
            tier: "Standard",
        },

        // Kubernetes version
        kubernetesVersion: config.kubernetesVersion,

        // DNS prefix for cluster FQDN
        dnsPrefix: `${config.environment}-aks`,

        // System node pool (required even in Automatic mode)
        agentPoolProfiles: [{
            name: "system",
            mode: "System",
            vmSize: config.systemPoolVmSize,
            osType: "Linux",
            osSKU: "AzureLinux",
            count: config.systemPoolMinCount,
            minCount: config.systemPoolMinCount,
            maxCount: config.systemPoolMaxCount,
            enableAutoScaling: true,
            type: "VirtualMachineScaleSets",
            enableNodePublicIP: false,
            // ARM64 nodes
            kubeletDiskType: "OS",
        }],

        // Azure CNI Overlay with Cilium (preconfigured in Automatic)
        networkProfile: {
            networkPlugin: "azure",
            networkPluginMode: "overlay",
            networkDataplane: "cilium",
            loadBalancerSku: "standard",
            serviceCidr: "10.0.0.0/16",
            dnsServiceIP: "10.0.0.10",
        },

        // Node Auto-Provisioning (NAP) - automatically creates nodes based on workload demands
        nodeProvisioningProfile: {
            mode: "Auto",
        },

        // Auto-upgrade configuration
        autoUpgradeProfile: {
            upgradeChannel: "stable",
            nodeOSUpgradeChannel: "NodeImage",
        },

        // OIDC issuer for workload identity
        oidcIssuerProfile: {
            enabled: true,
        },

        // Security profile with workload identity
        securityProfile: {
            workloadIdentity: {
                enabled: true,
            },
        },

        // Azure RBAC for Kubernetes authorization
        aadProfile: {
            managed: true,
            enableAzureRBAC: true,
        },

        // Enable managed identity
        identity: {
            type: "SystemAssigned",
        },

        // SSH access for nodes
        linuxProfile: {
            adminUsername: "azureuser",
            ssh: {
                publicKeys: [{
                    keyData: config.sshPubKey,
                }],
            },
        },

        // Auto-scaler profile
        autoScalerProfile: {
            scaleDownDelayAfterAdd: "10m",
            scaleDownUnneededTime: "10m",
            scaleDownUtilizationThreshold: "0.5",
        },

        // Tags
        tags: {
            environment: config.environment,
            managedBy: "pulumi",
        },
    });

    // Get admin credentials for cluster access
    const adminCredentials = pulumi.all([config.resourceGroupName, managedCluster.name]).apply(
        ([rgName, clusterName]) =>
            azurenative.containerservice.listManagedClusterAdminCredentials({
                resourceGroupName: rgName,
                resourceName: clusterName,
            })
    );

    // Decode kubeconfig from base64
    const kubeconfig = adminCredentials.kubeconfigs[0].value.apply(enc =>
        Buffer.from(enc, "base64").toString()
    );

    return {
        cluster: managedCluster,
        kubeconfig: kubeconfig,
        clusterName: managedCluster.name,
        oidcIssuerUrl: managedCluster.oidcIssuerProfile.apply(profile => profile?.issuerUrl || ""),
        fqdn: managedCluster.fqdn,
    };
}
