import * as k8s from "@pulumi/kubernetes";

/**
 * Patches AKS-managed Karpenter NodePools for cost optimization.
 *
 * AKS Automatic creates its own "default" and "system-surge" NodePools via
 * the aks-managed-karpenter-overlay Helm release. We cannot replace them, but
 * we can server-side-apply field-level patches that survive until the next AKS
 * reconciliation (which only runs on cluster upgrades / sku changes).
 *
 * Changes applied:
 *  1. default    — add "spot" to capacity-type (alongside on-demand)
 *  2. system-surge — switch architecture from amd64 → arm64
 */

export interface KarpenterPatchConfig {
    provider: k8s.Provider;
    environment: string;
}

export function patchKarpenterNodePools(config: KarpenterPatchConfig) {
    const { provider, environment } = config;

    // --- 1. Patch "default" NodePool: enable spot instances ---
    // The AKS-managed default pool only allows on-demand. Adding spot lets
    // Karpenter pick spot VMs for stateless workloads (~80% cheaper).
    const defaultSpotPatch = new k8s.apiextensions.CustomResource(
        `karpenter-default-spot-patch-${environment}`,
        {
            apiVersion: "karpenter.sh/v1",
            kind: "NodePool",
            metadata: {
                name: "default",
                annotations: {
                    "pulumi.com/patchForce": "true",
                },
            },
            spec: {
                template: {
                    metadata: {
                        labels: {
                            "kubernetes.azure.com/ebpf-dataplane": "cilium",
                        },
                    },
                    spec: {
                        expireAfter: "Never",
                        nodeClassRef: {
                            group: "karpenter.azure.com",
                            kind: "AKSNodeClass",
                            name: "default",
                        },
                        requirements: [
                            {
                                key: "kubernetes.io/arch",
                                operator: "In",
                                values: ["arm64"],
                            },
                            {
                                key: "kubernetes.io/os",
                                operator: "In",
                                values: ["linux"],
                            },
                            {
                                key: "karpenter.sh/capacity-type",
                                operator: "In",
                                values: ["on-demand", "spot"],
                            },
                            {
                                key: "karpenter.azure.com/sku-family",
                                operator: "In",
                                values: ["D"],
                            },
                        ],
                        startupTaints: [
                            {
                                effect: "NoExecute",
                                key: "node.cilium.io/agent-not-ready",
                                value: "true",
                            },
                        ],
                    },
                },
                disruption: {
                    budgets: [{ nodes: "30%" }],
                    consolidateAfter: "0s",
                    consolidationPolicy: "WhenEmptyOrUnderutilized",
                },
            },
        },
        {
            provider,
        },
    );

    // --- 2. Patch "system-surge" NodePool: amd64 → arm64 ---
    // ARM64 D-series VMs are ~15-20% cheaper than amd64 equivalents.
    // All AKS system components support ARM64 on AKS Automatic.
    const systemSurgeArm64Patch = new k8s.apiextensions.CustomResource(
        `karpenter-system-surge-arm64-patch-${environment}`,
        {
            apiVersion: "karpenter.sh/v1",
            kind: "NodePool",
            metadata: {
                name: "system-surge",
                annotations: {
                    "pulumi.com/patchForce": "true",
                },
            },
            spec: {
                template: {
                    metadata: {
                        labels: {
                            "kubernetes.azure.com/ebpf-dataplane": "cilium",
                            "kubernetes.azure.com/mode": "system",
                        },
                    },
                    spec: {
                        expireAfter: "Never",
                        nodeClassRef: {
                            group: "karpenter.azure.com",
                            kind: "AKSNodeClass",
                            name: "system-surge",
                        },
                        requirements: [
                            {
                                key: "kubernetes.io/arch",
                                operator: "In",
                                values: ["arm64"],
                            },
                            {
                                key: "kubernetes.io/os",
                                operator: "In",
                                values: ["linux"],
                            },
                            {
                                key: "karpenter.sh/capacity-type",
                                operator: "In",
                                values: ["on-demand"],
                            },
                            {
                                key: "karpenter.azure.com/sku-family",
                                operator: "In",
                                values: ["D"],
                            },
                        ],
                        startupTaints: [
                            {
                                effect: "NoExecute",
                                key: "node.cilium.io/agent-not-ready",
                                value: "true",
                            },
                        ],
                        taints: [
                            {
                                effect: "NoSchedule",
                                key: "CriticalAddonsOnly",
                                value: "true",
                            },
                        ],
                    },
                },
                disruption: {
                    budgets: [{ nodes: "10%" }],
                    consolidateAfter: "0s",
                    consolidationPolicy: "WhenEmptyOrUnderutilized",
                },
            },
        },
        {
            provider,
        },
    );

    return {
        defaultSpotPatch,
        systemSurgeArm64Patch,
    };
}
