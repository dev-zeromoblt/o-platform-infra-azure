import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as authorization from "@pulumi/azure-native/authorization";

export interface WorkloadIdentityConfig {
    provider: k8s.Provider;
    namespace: string;
    serviceAccountName: string;
    azureClientId: string;
    environment: string;
}

/**
 * Creates a ServiceAccount with workload identity annotations for Azure AD integration
 *
 * After creating this, configure Azure workload identity:
 * 1. Get OIDC issuer URL from cluster output
 * 2. Create Azure Managed Identity
 * 3. Assign necessary Azure RBAC roles to the managed identity
 * 4. Add federated credential in Azure AD linking to this K8s service account
 */
export function createWorkloadIdentityServiceAccount(config: WorkloadIdentityConfig) {
    // Create namespace if it doesn't exist
    const namespace = new k8s.core.v1.Namespace(
        `${config.namespace}-${config.environment}`,
        {
            metadata: {
                name: config.namespace,
            },
        },
        { provider: config.provider }
    );

    // Create ServiceAccount with workload identity annotations
    const serviceAccount = new k8s.core.v1.ServiceAccount(
        `${config.serviceAccountName}-${config.environment}`,
        {
            metadata: {
                name: config.serviceAccountName,
                namespace: config.namespace,
                annotations: {
                    "azure.workload.identity/client-id": config.azureClientId,
                    "azure.workload.identity/tenant-id": pulumi.output(
                        authorization.getClientConfig()
                    ).tenantId,
                },
                labels: {
                    "azure.workload.identity/use": "true",
                },
            },
        },
        {
            provider: config.provider,
            dependsOn: namespace,
        }
    );

    return {
        namespace,
        serviceAccount,
    };
}

/**
 * Example Pod using workload identity
 */
export function createWorkloadIdentityPodExample(
    provider: k8s.Provider,
    namespace: string,
    serviceAccountName: string,
    environment: string
) {
    return new k8s.core.v1.Pod(
        `workload-identity-example-${environment}`,
        {
            metadata: {
                name: "workload-identity-example",
                namespace: namespace,
                labels: {
                    "azure.workload.identity/use": "true",
                },
            },
            spec: {
                serviceAccountName: serviceAccountName,
                containers: [
                    {
                        name: "app",
                        image: "mcr.microsoft.com/azure-cli:latest",
                        command: ["sleep", "infinity"],
                        env: [
                            {
                                name: "AZURE_CLIENT_ID",
                                valueFrom: {
                                    secretKeyRef: {
                                        name: serviceAccountName,
                                        key: "clientId",
                                    },
                                },
                            },
                        ],
                    },
                ],
            },
        },
        { provider }
    );
}
