import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as crypto from "crypto";

/**
 * Creates a least-privilege Postgres role for HedgeDoc and hands it ownership of
 * its own database.
 *
 * Without this the application connects as the Flexible Server administrator, so
 * an RCE or a `kubectl exec` into the pod yields admin over every database on the
 * server rather than just HedgeDoc's. That matters more than usual here because
 * the firewall admits the shared cluster NAT address, which means any pod in any
 * namespace can already open a socket to 5432.
 *
 * The work runs as a Kubernetes Job rather than a Pulumi Postgres provider
 * because the server is only reachable from inside the cluster — Pulumi running
 * on a laptop or in CI cannot connect to it.
 */
export interface HedgeDocDbBootstrapConfig {
    provider: k8s.Provider;
    environment: string;
    namespace: pulumi.Input<string>;
    labels: { [k: string]: string };
    host: pulumi.Input<string>;
    databaseName: string;
    adminUser: string;
    adminPassword: pulumi.Input<string>;
    appUser: string;
    appPassword: pulumi.Input<string>;
    /** postgres client image used to run the bootstrap SQL */
    image: string;
    dependsOn?: pulumi.Resource[];
}

/**
 * Idempotent: safe to re-run on every deploy.
 *
 * psql substitutes `:'name'` / `:"name"` before sending, which keeps identifiers
 * and literals correctly quoted. Variables are not substituted inside
 * dollar-quoted blocks, so ownership transfer is driven by `\gexec` over a
 * generated statement list instead of a DO block.
 */
const BOOTSTRAP_SQL = `\\set ON_ERROR_STOP on

-- Create the application role if it is not already there.
SELECT format('CREATE ROLE %I LOGIN', :'app_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user');
\\gexec

-- Always (re)set the password so rotating it is just a config change.
ALTER ROLE :"app_user" WITH LOGIN PASSWORD :'app_password';

-- The admin has to be a member of the role before it can hand ownership over.
SELECT format('GRANT %I TO CURRENT_USER', :'app_user')
WHERE NOT pg_has_role(CURRENT_USER, :'app_user', 'MEMBER');
\\gexec

-- The application owns its own database and schema, and nothing else.
ALTER DATABASE :"db_name" OWNER TO :"app_user";
ALTER SCHEMA public OWNER TO :"app_user";
GRANT ALL ON SCHEMA public TO :"app_user";

-- Adopt objects left over from the earlier admin-owned deployment, so sequelize
-- migrations keep working after the switch.
SELECT format('ALTER TABLE public.%I OWNER TO %I', tablename, :'app_user')
FROM pg_tables WHERE schemaname = 'public' AND tableowner <> :'app_user';
\\gexec

SELECT format('ALTER SEQUENCE public.%I OWNER TO %I', sequencename, :'app_user')
FROM pg_sequences WHERE schemaname = 'public' AND sequenceowner <> :'app_user';
\\gexec
`;

export function createHedgeDocDbBootstrap(config: HedgeDocDbBootstrapConfig) {
    const env = config.environment;
    const opts = { provider: config.provider, dependsOn: config.dependsOn || [] };

    const sqlConfigMap = new k8s.core.v1.ConfigMap(`hedgedoc-db-bootstrap-sql-${env}`, {
        metadata: {
            name: "hedgedoc-db-bootstrap-sql",
            namespace: config.namespace,
            labels: config.labels,
        },
        data: { "bootstrap.sql": BOOTSTRAP_SQL },
    }, opts);

    // Admin credentials live only here — they are never exposed to the app pod.
    const bootstrapSecret = new k8s.core.v1.Secret(`hedgedoc-db-bootstrap-secret-${env}`, {
        metadata: {
            name: "hedgedoc-db-bootstrap",
            namespace: config.namespace,
            labels: config.labels,
        },
        type: "Opaque",
        stringData: {
            PGHOST: config.host,
            PGUSER: config.adminUser,
            PGPASSWORD: config.adminPassword,
            PGDATABASE: config.databaseName,
            APP_USER: config.appUser,
            APP_PASSWORD: config.appPassword,
        },
    }, opts);

    // A Job's pod template is immutable, so the name carries a hash of the inputs
    // that matter: changing the app password produces a new Job that re-runs.
    const jobSuffix = pulumi
        .all([config.appPassword, config.host, pulumi.output(config.appUser)])
        .apply(([pw, host, user]) =>
            crypto.createHash("sha256").update(`${user}@${host}:${pw}`).digest("hex").slice(0, 10)
        );

    const job = new k8s.batch.v1.Job(`hedgedoc-db-bootstrap-${env}`, {
        metadata: {
            name: pulumi.interpolate`hedgedoc-db-bootstrap-${jobSuffix}`,
            namespace: config.namespace,
            labels: config.labels,
        },
        spec: {
            backoffLimit: 4,
            // Keep a completed Job around briefly for debugging, then self-clean.
            ttlSecondsAfterFinished: 3600,
            template: {
                metadata: { labels: config.labels },
                spec: {
                    restartPolicy: "Never",
                    securityContext: {
                        runAsUser: 65532,
                        runAsGroup: 65532,
                        runAsNonRoot: true,
                        seccompProfile: { type: "RuntimeDefault" },
                    },
                    containers: [{
                        name: "psql",
                        image: config.image,
                        command: ["/bin/sh", "-c"],
                        args: [
                            // sslmode=require: Azure enforces TLS via require_secure_transport.
                            'exec psql "sslmode=require" -v ON_ERROR_STOP=1 ' +
                            '-v app_user="$APP_USER" -v app_password="$APP_PASSWORD" ' +
                            '-v db_name="$PGDATABASE" -f /sql/bootstrap.sql',
                        ],
                        envFrom: [{ secretRef: { name: bootstrapSecret.metadata.name } }],
                        // Azure Policy (k8sazurev1containerrequests) denies pods
                        // without resource requests on this cluster.
                        resources: {
                            requests: { cpu: "50m", memory: "64Mi" },
                            limits: { cpu: "500m", memory: "256Mi" },
                        },
                        securityContext: {
                            allowPrivilegeEscalation: false,
                            capabilities: { drop: ["ALL"] },
                            readOnlyRootFilesystem: true,
                        },
                        volumeMounts: [{ name: "sql", mountPath: "/sql", readOnly: true }],
                    }],
                    volumes: [{
                        name: "sql",
                        configMap: { name: sqlConfigMap.metadata.name },
                    }],
                },
            },
        },
    }, opts);

    return { job, sqlConfigMap, bootstrapSecret };
}
