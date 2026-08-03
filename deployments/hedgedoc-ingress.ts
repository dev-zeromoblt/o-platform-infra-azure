import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as azurenative from "@pulumi/azure-native";

/**
 * Public ingress for HedgeDoc: Azure DNS A record + AKS managed NGINX ingress
 * with a cert-manager issued Let's Encrypt certificate.
 */
export interface HedgeDocIngressConfig {
    provider: k8s.Provider;
    environment: string;
    /** Full hostname, e.g. docs.dev.az.zeromoblt.com */
    domain: string;
    /** Left-most label of the hostname used for the A record, e.g. "docs". */
    recordName: string;
    namespace: pulumi.Input<string>;
    serviceName: pulumi.Input<string>;
    servicePort: number;
    ingressIP: pulumi.Input<string>;
    dnsZoneName: pulumi.Input<string>;
    dnsResourceGroupName: pulumi.Input<string>;
    clusterIssuer: string;
    dependsOn?: pulumi.Resource[];
}

export function createHedgeDocIngress(config: HedgeDocIngressConfig) {
    const env = config.environment;

    // The zone already has a wildcard A record, but an explicit record keeps the
    // hostname working if the wildcard is ever narrowed.
    const dnsRecord = new azurenative.network.RecordSet(`hedgedoc-dns-${env}`, {
        resourceGroupName: config.dnsResourceGroupName,
        zoneName: config.dnsZoneName,
        relativeRecordSetName: config.recordName,
        recordType: "A",
        ttl: 300,
        aRecords: [{
            ipv4Address: config.ingressIP,
        }],
    });

    const ingress = new k8s.networking.v1.Ingress(`hedgedoc-ingress-${env}`, {
        metadata: {
            name: "hedgedoc-ingress",
            namespace: config.namespace,
            annotations: {
                "cert-manager.io/cluster-issuer": config.clusterIssuer,
                "nginx.ingress.kubernetes.io/ssl-redirect": "true",
                "nginx.ingress.kubernetes.io/force-ssl-redirect": "true",
                // HedgeDoc's realtime editing runs over a socket.io websocket that
                // stays open while a note is being edited; the 60s nginx default
                // would drop collaborators mid-session.
                "nginx.ingress.kubernetes.io/proxy-read-timeout": "3600",
                "nginx.ingress.kubernetes.io/proxy-send-timeout": "3600",
                // Image/document uploads.
                "nginx.ingress.kubernetes.io/proxy-body-size": "50m",
            },
        },
        spec: {
            ingressClassName: "webapprouting.kubernetes.azure.com",
            tls: [{
                hosts: [config.domain],
                secretName: `hedgedoc-tls-${env}`,
            }],
            rules: [{
                host: config.domain,
                http: {
                    paths: [{
                        path: "/",
                        pathType: "Prefix",
                        backend: {
                            service: {
                                name: config.serviceName,
                                port: {
                                    number: config.servicePort,
                                },
                            },
                        },
                    }],
                },
            }],
        },
    }, {
        provider: config.provider,
        dependsOn: [dnsRecord, ...(config.dependsOn || [])],
    });

    return {
        dnsRecord,
        ingress,
        url: `https://${config.domain}`,
    };
}
