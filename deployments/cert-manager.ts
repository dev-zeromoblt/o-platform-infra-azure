import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export interface CertManagerConfig {
    provider: k8s.Provider;
    environment: string;
    email: string;
}

export function installCertManager(config: CertManagerConfig) {
    // Create cert-manager namespace first
    const certManagerNamespace = new k8s.core.v1.Namespace(
        `cert-manager-ns-${config.environment}`,
        {
            metadata: {
                name: "cert-manager",
                labels: {
                    "app.kubernetes.io/managed-by": "pulumi",
                    environment: config.environment,
                }
            }
        },
        { provider: config.provider }
    );

    // Install cert-manager using Helm Release (not Chart - Release waits for deployment)
    const certManager = new k8s.helm.v3.Release(
        `cert-manager-${config.environment}`,
        {
            chart: "cert-manager",
            version: "v1.16.2",
            repositoryOpts: {
                repo: "https://charts.jetstack.io",
            },
            namespace: certManagerNamespace.metadata.name,
            skipCrds: false,
            values: {
                crds: {
                    enabled: true,
                    keep: true,
                },
                global: {
                    leaderElection: {
                        namespace: "cert-manager",
                    },
                },
                // Add resource requests for AKS Automatic Gatekeeper policies
                resources: {
                    requests: {
                        cpu: "10m",
                        memory: "32Mi",
                    },
                },
                webhook: {
                    timeoutSeconds: 30,
                    resources: {
                        requests: {
                            cpu: "10m",
                            memory: "32Mi",
                        },
                    },
                },
                cainjector: {
                    resources: {
                        requests: {
                            cpu: "10m",
                            memory: "32Mi",
                        },
                    },
                },
                startupapicheck: {
                    resources: {
                        requests: {
                            cpu: "10m",
                            memory: "32Mi",
                        },
                    },
                },
            },
            skipAwait: false, // Wait for deployment to be ready before proceeding
        },
        {
            provider: config.provider,
            dependsOn: [certManagerNamespace]
        }
    );

    // Create Let's Encrypt ClusterIssuer (production)
    const clusterIssuerProd = new k8s.apiextensions.CustomResource(
        `letsencrypt-prod-${config.environment}`,
        {
            apiVersion: "cert-manager.io/v1",
            kind: "ClusterIssuer",
            metadata: {
                name: "letsencrypt-prod",
            },
            spec: {
                acme: {
                    server: "https://acme-v02.api.letsencrypt.org/directory",
                    email: config.email,
                    privateKeySecretRef: {
                        name: "letsencrypt-prod",
                    },
                    solvers: [
                        {
                            http01: {
                                ingress: {
                                    class: "webapprouting.kubernetes.azure.com",
                                },
                            },
                        },
                    ],
                },
            },
        },
        {
            provider: config.provider,
            dependsOn: [certManager],
        }
    );

    // Create Let's Encrypt ClusterIssuer (staging for testing)
    const clusterIssuerStaging = new k8s.apiextensions.CustomResource(
        `letsencrypt-staging-${config.environment}`,
        {
            apiVersion: "cert-manager.io/v1",
            kind: "ClusterIssuer",
            metadata: {
                name: "letsencrypt-staging",
            },
            spec: {
                acme: {
                    server: "https://acme-staging-v02.api.letsencrypt.org/directory",
                    email: config.email,
                    privateKeySecretRef: {
                        name: "letsencrypt-staging",
                    },
                    solvers: [
                        {
                            http01: {
                                ingress: {
                                    class: "webapprouting.kubernetes.azure.com",
                                },
                            },
                        },
                    ],
                },
            },
        },
        {
            provider: config.provider,
            dependsOn: [certManager],
        }
    );

    return {
        release: certManager,
        namespace: certManagerNamespace,
        clusterIssuerProd,
        clusterIssuerStaging,
    };
}
