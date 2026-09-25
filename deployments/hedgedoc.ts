import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as crypto from "crypto";

/**
 * HedgeDoc (https://hedgedoc.org) collaborative markdown notes.
 *
 * HedgeDoc 1.x keeps realtime note state in process memory, so it is explicitly
 * unsupported to run more than one instance against the same database:
 * https://docs.hedgedoc.org/faq/ — "running more than one instance will result in
 * missing/broken content for users". This deployment is therefore pinned to a
 * single replica with a Recreate strategy and scaled vertically instead. Startup
 * is a few seconds, so rolling a node costs a short blip rather than data loss.
 */
export interface HedgeDocConfig {
    provider: k8s.Provider;
    environment: string;
    /**
     * Created by the caller so the database bootstrap Job can be sequenced
     * between the namespace and this Deployment.
     */
    namespace: k8s.core.v1.Namespace;
    /** Public hostname, e.g. docs.dev.az.zeromoblt.com */
    domain: string;
    image: string;
    dbConnectionString: pulumi.Input<string>;
    sessionSecret: pulumi.Input<string>;
    /**
     * Google OAuth credentials. When omitted HedgeDoc still boots and runs its
     * migrations but exposes no way to sign in — set them to open it to users.
     */
    googleClientId?: pulumi.Input<string>;
    googleClientSecret?: pulumi.Input<string>;
    /** Google Workspace domain users must belong to, e.g. zeromoblt.com */
    googleHostedDomain: string;
    uploadsStorageSize: string;
    uploadsStorageClass: string;
    cpuRequest: string;
    cpuLimit: string;
    memoryRequest: string;
    memoryLimit: string;
    dependsOn?: pulumi.Resource[];
}

/** Image runs as uid/gid 10000 (hedgedoc); fsGroup lets it write the uploads PVC. */
const HEDGEDOC_UID = 10000;
const CONTAINER_PORT = 3000;

export function createHedgeDoc(config: HedgeDocConfig) {
    const env = config.environment;
    const labels = {
        app: "hedgedoc",
        environment: env,
    };
    const opts = { provider: config.provider, dependsOn: config.dependsOn || [] };

    const namespace = config.namespace;

    const secret = new k8s.core.v1.Secret(`hedgedoc-secret-${env}`, {
        metadata: {
            name: "hedgedoc-secrets",
            namespace: namespace.metadata.name,
            labels: labels,
        },
        type: "Opaque",
        stringData: {
            CMD_DB_URL: config.dbConnectionString,
            CMD_SESSION_SECRET: config.sessionSecret,
            ...(config.googleClientId && config.googleClientSecret
                ? {
                    CMD_GOOGLE_CLIENTID: config.googleClientId,
                    CMD_GOOGLE_CLIENTSECRET: config.googleClientSecret,
                }
                : {}),
        },
    }, opts);

    // Sequelize is constructed as `new Sequelize(config.dbURL, config.db)`, so TLS
    // options have to arrive through config.json rather than the CMD_DB_URL query
    // string. Azure Postgres certs chain to DigiCert Global Root G2, which Node
    // trusts, so full verification stays on.
    const configMap = new k8s.core.v1.ConfigMap(`hedgedoc-config-${env}`, {
        metadata: {
            name: "hedgedoc-config",
            namespace: namespace.metadata.name,
            labels: labels,
        },
        data: {
            "config.json": JSON.stringify({
                production: {
                    db: {
                        dialect: "postgres",
                        dialectOptions: {
                            ssl: {
                                require: true,
                                rejectUnauthorized: true,
                            },
                        },
                    },
                },
            }, null, 2),
        },
    }, opts);

    const uploadsPvc = new k8s.core.v1.PersistentVolumeClaim(`hedgedoc-uploads-${env}`, {
        metadata: {
            name: "hedgedoc-uploads",
            namespace: namespace.metadata.name,
            labels: labels,
        },
        spec: {
            accessModes: ["ReadWriteOnce"],
            storageClassName: config.uploadsStorageClass,
            resources: {
                requests: {
                    storage: config.uploadsStorageSize,
                },
            },
        },
    }, opts);

    const env_vars: k8s.types.input.core.v1.EnvVar[] = [
        // --- Public URL ---
        { name: "CMD_DOMAIN", value: config.domain },
        { name: "CMD_PROTOCOL_USESSL", value: "true" },
        { name: "CMD_URL_ADDPORT", value: "false" },
        { name: "CMD_PORT", value: String(CONTAINER_PORT) },
        { name: "CMD_HOST", value: "0.0.0.0" },

        // --- Access control: Google Workspace SSO only ---
        { name: "CMD_ALLOW_ANONYMOUS", value: "false" },
        { name: "CMD_ALLOW_ANONYMOUS_EDITS", value: "false" },
        { name: "CMD_ALLOW_EMAIL_REGISTER", value: "false" },
        { name: "CMD_EMAIL", value: "false" },
        { name: "CMD_ALLOW_FREEURL", value: "true" },
        { name: "CMD_REQUIRE_FREEURL_AUTHENTICATION", value: "true" },
        { name: "CMD_DEFAULT_PERMISSION", value: "limited" },
        { name: "CMD_GOOGLE_HOSTEDDOMAIN", value: config.googleHostedDomain },

        // --- Uploads on the mounted PVC ---
        { name: "CMD_IMAGE_UPLOAD_TYPE", value: "filesystem" },

        // --- Hardening / privacy for an internal tool ---
        { name: "CMD_HSTS_ENABLE", value: "true" },
        { name: "CMD_CSP_ENABLE", value: "true" },
        { name: "CMD_ALLOW_GRAVATAR", value: "false" },
        { name: "CMD_USECDN", value: "false" },
    ];

    const probe = (): k8s.types.input.core.v1.Probe => ({
        httpGet: {
            path: "/_health",
            port: CONTAINER_PORT,
        },
    });

    const deployment = new k8s.apps.v1.Deployment(`hedgedoc-deploy-${env}`, {
        metadata: {
            name: "hedgedoc",
            namespace: namespace.metadata.name,
            labels: labels,
        },
        spec: {
            // Single instance only — see the file header.
            replicas: 1,
            strategy: {
                type: "Recreate",
            },
            selector: {
                matchLabels: labels,
            },
            template: {
                metadata: {
                    labels: labels,
                    annotations: {
                        // Roll the pod when the mounted config.json changes.
                        "checksum/config": configMap.data.apply(d =>
                            crypto.createHash("sha256").update(JSON.stringify(d)).digest("hex").slice(0, 16)
                        ),
                    },
                },
                spec: {
                    // The default Karpenter NodePool offers spot alongside
                    // on-demand (see karpenter-patches.ts). A spot reclaim is an
                    // involuntary eviction, so a PodDisruptionBudget cannot
                    // prevent it — and because this single replica holds every
                    // active editing session in memory, losing it drops live
                    // collaborative state. Pin to on-demand instead.
                    affinity: {
                        nodeAffinity: {
                            requiredDuringSchedulingIgnoredDuringExecution: {
                                nodeSelectorTerms: [{
                                    matchExpressions: [{
                                        key: "karpenter.sh/capacity-type",
                                        operator: "In",
                                        values: ["on-demand"],
                                    }],
                                }],
                            },
                        },
                    },
                    securityContext: {
                        runAsUser: HEDGEDOC_UID,
                        runAsGroup: HEDGEDOC_UID,
                        fsGroup: HEDGEDOC_UID,
                        runAsNonRoot: true,
                        seccompProfile: {
                            type: "RuntimeDefault",
                        },
                    },
                    containers: [{
                        name: "hedgedoc",
                        image: config.image,
                        imagePullPolicy: "IfNotPresent",
                        ports: [{
                            name: "http",
                            containerPort: CONTAINER_PORT,
                            protocol: "TCP",
                        }],
                        env: env_vars,
                        envFrom: [{
                            secretRef: {
                                name: secret.metadata.name,
                            },
                        }],
                        // Azure Policy (k8sazurev1containerrequests) denies pods
                        // without resource requests on this cluster.
                        resources: {
                            requests: {
                                cpu: config.cpuRequest,
                                memory: config.memoryRequest,
                            },
                            limits: {
                                cpu: config.cpuLimit,
                                memory: config.memoryLimit,
                            },
                        },
                        // First boot runs sequelize migrations, so give startup a
                        // generous window before liveness can kill the pod.
                        startupProbe: {
                            ...probe(),
                            periodSeconds: 5,
                            failureThreshold: 60,
                        },
                        readinessProbe: {
                            ...probe(),
                            periodSeconds: 10,
                            timeoutSeconds: 3,
                            failureThreshold: 3,
                        },
                        livenessProbe: {
                            ...probe(),
                            periodSeconds: 20,
                            timeoutSeconds: 5,
                            failureThreshold: 3,
                        },
                        securityContext: {
                            allowPrivilegeEscalation: false,
                            capabilities: {
                                drop: ["ALL"],
                            },
                            // HedgeDoc writes transient files under its workdir.
                            readOnlyRootFilesystem: false,
                        },
                        volumeMounts: [
                            {
                                name: "uploads",
                                mountPath: "/hedgedoc/public/uploads",
                            },
                            {
                                // /hedgedoc/config.json is a symlink to /files/config.json.
                                name: "config",
                                mountPath: "/files",
                                readOnly: true,
                            },
                        ],
                    }],
                    volumes: [
                        {
                            name: "uploads",
                            persistentVolumeClaim: {
                                claimName: uploadsPvc.metadata.name,
                            },
                        },
                        {
                            name: "config",
                            configMap: {
                                name: configMap.metadata.name,
                            },
                        },
                    ],
                },
            },
        },
    }, opts);

    const service = new k8s.core.v1.Service(`hedgedoc-svc-${env}`, {
        metadata: {
            name: "hedgedoc",
            namespace: namespace.metadata.name,
            labels: labels,
        },
        spec: {
            type: "ClusterIP",
            selector: labels,
            ports: [{
                name: "http",
                port: 80,
                targetPort: CONTAINER_PORT,
                protocol: "TCP",
            }],
        },
    }, opts);

    return {
        namespace,
        namespaceName: namespace.metadata.name,
        deployment,
        service,
        serviceName: service.metadata.name,
        servicePort: 80,
        uploadsPvc,
        secret,
        configMap,
    };
}
