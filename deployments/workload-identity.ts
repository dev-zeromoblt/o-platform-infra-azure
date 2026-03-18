import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export interface WorkloadIdentityConfig {
    provider: k8s.Provider;
    namespace: string;
    serviceAccountName: string;
    azureClientId: string;
    environment: string;
}

/**
 * Creates a ServiceAccount with workload identity annotations for AWS federation
 *
 * After creating this, configure AWS IAM:
 * 1. Get OIDC issuer URL from cluster output
 * 2. Create AWS IAM OIDC Identity Provider with the issuer URL
 * 3. Create IAM role with trust policy allowing the OIDC provider
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
                        require("@pulumi/azure-native").authorization.getClientConfig()
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
