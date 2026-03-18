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
        agentPoolProfiles: [{
            name: "system",
            mode: "System",
            vmSize: config.systemPoolVmSize,
            osType: "Linux",
            osSKU: "AzureLinux",
            count: config.systemPoolMinCount,
            enableAutoScaling: false,
            type: "VirtualMachineScaleSets",
            enableNodePublicIP: false,
        }],

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
        // No explicit configuration needed - it's part of the Automatic SKU

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

    // Note: RBAC role assignment should be done manually or via separate deployment
    // az role assignment create --assignee <user-id> --role "Azure Kubernetes Service RBAC Cluster Admin" --scope <cluster-id>

    return {
        cluster: managedCluster,
        kubeconfig: kubeconfig,
        clusterName: managedCluster.name,
        oidcIssuerUrl: managedCluster.oidcIssuerProfile.apply(profile => profile?.issuerURL || ""),
        fqdn: managedCluster.fqdn,
    };
}
