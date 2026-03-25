import * as pulumi from "@pulumi/pulumi";
import * as azurenative from "@pulumi/azure-native";

export interface ClusterConfig {
    resourceGroupName: pulumi.Input<string>;
    environment: string;
    kubernetesVersion: string;
    systemPoolVmSize: string;
    systemPoolMinCount: number;
    systemPoolMaxCount: number;
    sshPubKey: string;
    adminUserObjectId?: string;
}

export function createAksCluster(config: ClusterConfig) {
    const clusterName = `aks-${config.environment}`;

    // Create AKS Automatic cluster with Standard tier
    const managedCluster = new azurenative.containerservice.ManagedCluster(clusterName, {
        resourceGroupName: config.resourceGroupName,
        location: pulumi.output(config.resourceGroupName).apply(rgName =>
            azurenative.resources.getResourceGroup({ resourceGroupName: rgName })
        ).apply(rg => rg.location),

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
        // Note: enableAutoScaling must be false when using NAP (Node Auto-Provisioning)
        // Note: AKS Automatic requires ephemeral OS disks, so VM size must have ≥128 GB temp storage
        agentPoolProfiles: [
            {
                name: "system",
                mode: "System",
                vmSize: config.systemPoolVmSize,
                osType: "Linux",
                osSKU: "AzureLinux",
                count: config.systemPoolMinCount,
                enableAutoScaling: false,
                type: "VirtualMachineScaleSets",
                enableNodePublicIP: false,
            },
            // Add data node pool only for production
            ...(config.environment === "prod" ? [{
                name: "data",
                mode: "User" as const,
                vmSize: "Standard_D2pds_v5",  // Must have ≥128 GB temp storage for ephemeral OS
                osType: "Linux" as const,
                osSKU: "AzureLinux" as const,
                count: 3,
                enableAutoScaling: false,
                type: "VirtualMachineScaleSets" as const,
                enableNodePublicIP: false,
            }] : []),
        ],

        // Azure CNI Overlay with Cilium (preconfigured in Automatic)
        networkProfile: {
            networkPlugin: "azure",
            networkPluginMode: "overlay",
            networkDataplane: "cilium",
            loadBalancerSku: "standard",
            outboundType: "managedNATGateway",
            serviceCidr: "10.0.0.0/16",
            dnsServiceIP: "10.0.0.10",
        },

        // Note: Node Auto-Provisioning (NAP) is automatically enabled in AKS Automatic mode
        // ARM64 configuration will be applied post-deployment via scripts/configure-arm64-nap.sh

        // Auto-upgrade configuration
        autoUpgradeProfile: {
            upgradeChannel: "stable",
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

        // Auto-scaler profile for NAP behavior
        // Note: NAP in AKS Automatic will provision ARM64 nodes (Dpsv5/Dplsv5/Epsv5 families) by default
        // Workloads can override by using nodeSelector for specific agent pools (e.g., "data" pool)
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

    // Get user credentials for cluster access (admin credentials disabled in Automatic mode)
    const userCredentials = pulumi.all([config.resourceGroupName, managedCluster.name]).apply(
        ([rgName, clusterName]) =>
            azurenative.containerservice.listManagedClusterUserCredentials({
                resourceGroupName: rgName,
                resourceName: clusterName,
            })
    );

    // Decode kubeconfig from base64
    const kubeconfig = userCredentials.kubeconfigs[0].value.apply(enc =>
        Buffer.from(enc, "base64").toString()
    );

    // Grant Azure RBAC Cluster Admin role to the specified user/service principal
    // This is required when enableAzureRBAC is true (configured in aadProfile above)
    // Role: Azure Kubernetes Service RBAC Cluster Admin (b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b)
    let roleAssignment: azurenative.authorization.RoleAssignment | undefined;
    if (config.adminUserObjectId) {
        roleAssignment = new azurenative.authorization.RoleAssignment(
            `${clusterName}-admin-rbac`,
            {
                principalId: config.adminUserObjectId,
                // Azure Kubernetes Service RBAC Cluster Admin role
                // Built-in role ID: b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b (Microsoft-defined constant)
                roleDefinitionId: managedCluster.id.apply(clusterId => {
                    // Extract subscription ID from cluster ID
                    const subscriptionId = clusterId.split('/')[2];
                    return `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b`;
                }),
                scope: managedCluster.id,
                principalType: "User",
            },
            {
                dependsOn: [managedCluster],
            }
        );
    }

    return {
        cluster: managedCluster,
        kubeconfig: kubeconfig,
        clusterName: managedCluster.name,
        oidcIssuerUrl: managedCluster.oidcIssuerProfile.apply(profile => profile?.issuerURL || ""),
        fqdn: managedCluster.fqdn,
        roleAssignment: roleAssignment,
    };
}
