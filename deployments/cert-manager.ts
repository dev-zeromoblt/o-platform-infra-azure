import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export interface CertManagerConfig {
    provider: k8s.Provider;
    environment: string;
    email: string;
}

export function installCertManager(config: CertManagerConfig) {
    // Install cert-manager via Helm
    const certManager = new k8s.helm.v3.Chart(
        `cert-manager-${config.environment}`,
        {
            chart: "cert-manager",
            version: "v1.16.2",
            namespace: "cert-manager",
            fetchOpts: {
                repo: "https://charts.jetstack.io",
            },
            values: {
                installCRDs: true,
                global: {
                    leaderElection: {
                        namespace: "cert-manager",
                    },
                },
            },
        },
        { provider: config.provider }
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
            dependsOn: certManager,
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
            dependsOn: certManager,
        }
    );

    return {
        chart: certManager,
        clusterIssuerProd,
        clusterIssuerStaging,
    };
}
