import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export interface IngressConfig {
    kubeconfig: pulumi.Input<string>;
    environment: string;
    dependsOn?: pulumi.Resource[];
}

export function getIngressController(config: IngressConfig) {
    // Create Kubernetes provider
    // Note: dependsOn ensures RBAC role assignment completes before accessing cluster
    const k8sProvider = new k8s.Provider(`k8s-provider-${config.environment}`, {
        kubeconfig: config.kubeconfig,
    }, {
        dependsOn: config.dependsOn || [],
    });

    // AKS Automatic includes a managed NGINX ingress controller in app-routing-system namespace
    // We just need to get its LoadBalancer IP
    const ingressService = k8s.core.v1.Service.get(
        `app-routing-nginx-${config.environment}`,
        pulumi.interpolate`app-routing-system/nginx`,
        { provider: k8sProvider }
    );

    // Extract the LoadBalancer IP
    const ingressIP = ingressService.status.apply(status => {
        if (status?.loadBalancer?.ingress && status.loadBalancer.ingress.length > 0) {
            return status.loadBalancer.ingress[0].ip || "";
        }
        return "";
    });

    return {
        provider: k8sProvider,
        service: ingressService,
        ip: ingressIP,
    };
}
