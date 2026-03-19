import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

/**
 * Creates Karpenter NodePools for AKS Automatic cluster mode
 *
 * For production stateful workloads like Redpanda, this creates a dedicated NodePool with:
 * - On-demand ARM64 instances (better cost/performance)
 * - Memory-optimized VMs with NVMe storage (Standard_D8ps_v5 series)
 * - Disruption protection (consolidation only when empty)
 * - Dedicated taints to prevent other workloads from scheduling
 *
 * References:
 * - https://docs.redpanda.com/current/deploy/redpanda/kubernetes/aks-guide/
 * - https://karpenter.sh/docs/concepts/nodepools/
 */

export interface KarpenterNodePoolConfig {
    provider: k8s.Provider;
    environment: string;
}

export function createRedpandaNodePool(config: KarpenterNodePoolConfig) {
    const { provider, environment } = config;

    // Only create for production and beta (dev uses default pool)
    if (environment === "dev") {
        return {
            nodePoolCreated: false,
            nodePoolName: undefined,
        };
    }

    // Karpenter NodePool for Redpanda data workloads
    // Uses ARM64 instances for better cost/performance
    const redpandaNodePool = new k8s.apiextensions.CustomResource(
        `redpanda-data-nodepool-${environment}`,
        {
            apiVersion: "karpenter.sh/v1",
            kind: "NodePool",
            metadata: {
                name: "redpanda-data",
                labels: {
                    environment: environment,
                    workload: "data",
                },
            },
            spec: {
                template: {
                    spec: {
                        requirements: [
                            {
                                // ARM64 architecture for better cost/performance
                                // Redpanda fully supports ARM64
                                key: "kubernetes.io/arch",
                                operator: "In",
                                values: ["arm64"],
                            },
                            {
                                // On-demand only - critical for stateful workloads
                                // Spot instances can be interrupted, causing data issues
                                key: "karpenter.sh/capacity-type",
                                operator: "In",
                                values: ["on-demand"],
                            },
                            {
                                // ARM64-based VMs (Redpanda uses managed Premium SSD CSI, not local NVMe)
                                // - Standard_D4ps_v5: 4 vCPU, 16GB RAM (fits 1-2 brokers)
                                // - Standard_D8ps_v5: 8 vCPU, 32GB RAM (for higher load)
                                // Note: "ps" suffix needed for ephemeral OS support in AKS Automatic
                                // Actual storage comes from managed Premium SSD (CSI), not local disk
                                key: "node.kubernetes.io/instance-type",
                                operator: "In",
                                values: [
                                    "Standard_D4ps_v5",
                                    "Standard_D8ps_v5"
                                ],
                            },
                            {
                                // Linux OS
                                key: "kubernetes.io/os",
                                operator: "In",
                                values: ["linux"],
                            },
                        ],
                        // Taints to dedicate these nodes exclusively to Redpanda
                        // This prevents other workloads from scheduling on these expensive nodes
                        taints: [
                            {
                                key: "workload",
                                value: "data",
                                effect: "NoSchedule",
                            },
                        ],
                        // Reference to the NodeClass (AKS NAP uses default NodeClass)
                        nodeClassRef: {
                            group: "karpenter.azure.com",
                            kind: "AKSNodeClass",
                            name: "default",
                        },
                    },
                    metadata: {
                        labels: {
                            workload: "data",
                            app: "redpanda",
                            environment: environment,
                        },
                    },
                },
                // Disruption settings - critical for stateful workloads
                disruption: {
                    // WhenEmpty: Only consolidate (remove) nodes when they have no pods
                    // This prevents Karpenter from disrupting running Redpanda brokers
                    consolidationPolicy: "WhenEmpty",

                    // Wait 1 hour before removing empty nodes
                    // Gives time for StatefulSets to reschedule if needed
                    consolidateAfter: "1h",

                    // Budget for controlled disruptions (e.g., during upgrades)
                    budgets: [
                        {
                            // Allow max 1 node to be disrupted at a time
                            // This ensures Redpanda maintains quorum during node replacements
                            nodes: "1",
                        },
                    ],
                },
                // Resource limits for this NodePool
                limits: {
                    cpu: "100",      // Max 100 CPUs across all nodes in this pool
                    memory: "400Gi", // Max 400Gi memory across all nodes in this pool
                },
                // Weight for multi-NodePool scenarios
                // Higher weight = preferred for scheduling
                weight: 10,
            },
        },
        { provider }
    );

    return {
        nodePoolCreated: true,
        nodePoolName: redpandaNodePool.metadata.apply(m => m.name),
        nodePool: redpandaNodePool,
    };
}

/**
 * Create general-purpose ARM64 NodePool for other workloads
 * This can run on spot instances to save costs
 */
export function createGeneralNodePool(config: KarpenterNodePoolConfig) {
    const { provider, environment } = config;

    const generalNodePool = new k8s.apiextensions.CustomResource(
        `general-purpose-nodepool-${environment}`,
        {
            apiVersion: "karpenter.sh/v1",
            kind: "NodePool",
            metadata: {
                name: "general-purpose",
                labels: {
                    environment: environment,
                    workload: "general",
                },
            },
            spec: {
                template: {
                    spec: {
                        requirements: [
                            {
                                // ARM64 for cost efficiency
                                key: "kubernetes.io/arch",
                                operator: "In",
                                values: ["arm64"],
                            },
                            {
                                // Allow both on-demand and spot for cost optimization
                                key: "karpenter.sh/capacity-type",
                                operator: "In",
                                values: ["on-demand", "spot"],
                            },
                            {
                                // ARM64 general-purpose instance types
                                key: "node.kubernetes.io/instance-type",
                                operator: "In",
                                values: [
                                    "Standard_D2ps_v5",
                                    "Standard_D4ps_v5",
                                    "Standard_D8ps_v5",
                                ],
                            },
                        ],
                        nodeClassRef: {
                            group: "karpenter.azure.com",
                            kind: "AKSNodeClass",
                            name: "default",
                        },
                    },
                },
                disruption: {
                    // More aggressive consolidation for cost savings
                    consolidationPolicy: "WhenEmptyOrUnderutilized",
                    consolidateAfter: "30s",
                },
                limits: {
                    cpu: "1000",
                    memory: "1000Gi",
                },
                weight: 1, // Lower priority than data NodePool
            },
        },
        { provider }
    );

    return {
        nodePoolCreated: true,
        nodePoolName: generalNodePool.metadata.apply(m => m.name),
        nodePool: generalNodePool,
    };
}
