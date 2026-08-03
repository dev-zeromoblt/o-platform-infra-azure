import * as pulumi from "@pulumi/pulumi";
import * as azurenative from "@pulumi/azure-native";

/**
 * Azure Database for PostgreSQL Flexible Server backing HedgeDoc.
 *
 * Networking, and why it is not a private endpoint:
 *
 * The preferred design was a private endpoint in the AKS node subnet. That is not
 * possible on an AKS Automatic cluster. AKS owns the VNet inside the MC_* node
 * resource group and applies a *deny assignment* to it, which blocks
 * `Microsoft.Network/virtualNetworks/subnets/join/action` and
 * `virtualNetworks/join/action` for every principal — deny assignments cannot be
 * overridden by granting RBAC roles. That rules out both a private endpoint in the
 * AKS subnet and peering a VNet of our own to it, and VNet integration is out too
 * because it needs a delegated subnet at server-creation time.
 *
 * So the server keeps a public endpoint, locked down by firewall to the cluster's
 * single egress address. The cluster uses a managed NAT gateway
 * (networkProfile.outboundType = managedNATGateway), so that address is stable for
 * the lifetime of the cluster rather than a rotating load-balancer IP.
 *
 * TLS is enforced by `require_secure_transport`, so traffic over that path is
 * encrypted and the certificate is verified client-side.
 */
export interface HedgeDocDatabaseConfig {
    environment: string;
    location: string;
    /** Egress addresses permitted to reach the server (AKS NAT gateway IP). */
    allowedEgressIps: string[];
    administratorLogin: string;
    administratorPassword: pulumi.Input<string>;
    databaseName: string;
    postgresVersion: string;
    skuName: string;
    skuTier: string;
    storageSizeGB: number;
    backupRetentionDays: number;
    /** Zone-redundant HA. Off for dev, on for prod. */
    highAvailability: boolean;
}

export function createHedgeDocDatabase(config: HedgeDocDatabaseConfig) {
    const env = config.environment;

    if (config.allowedEgressIps.length === 0) {
        throw new Error(
            "hedgedoc: allowedEgressIps must not be empty — the server would be unreachable from the cluster"
        );
    }

    const resourceGroup = new azurenative.resources.ResourceGroup(`hedgedoc-rg-${env}`, {
        resourceGroupName: `${env}-hedgedoc-rg`,
        location: config.location,
        tags: {
            environment: env,
            managedBy: "pulumi",
            application: "hedgedoc",
        },
    });

    const serverName = `psql-hedgedoc-${env}`;

    // Pinned to the 2024-08-01 API: the provider's default (2022-12-01) has neither
    // `network.publicNetworkAccess` nor `storage.autoGrow`.
    const server = new azurenative.dbforpostgresql.v20240801.Server(`hedgedoc-pg-${env}`, {
        serverName: serverName,
        resourceGroupName: resourceGroup.name,
        location: config.location,
        version: config.postgresVersion,
        createMode: "Default",
        administratorLogin: config.administratorLogin,
        administratorLoginPassword: config.administratorPassword,
        sku: {
            name: config.skuName,
            tier: config.skuTier,
        },
        storage: {
            storageSizeGB: config.storageSizeGB,
            autoGrow: "Enabled",
        },
        backup: {
            backupRetentionDays: config.backupRetentionDays,
            geoRedundantBackup: "Disabled",
        },
        highAvailability: {
            mode: config.highAvailability ? "ZoneRedundant" : "Disabled",
        },
        authConfig: {
            passwordAuth: "Enabled",
            activeDirectoryAuth: "Disabled",
        },
        network: {
            // Reachable only from the firewall-listed egress IPs below.
            publicNetworkAccess: "Enabled",
        },
        tags: {
            environment: env,
            managedBy: "pulumi",
            application: "hedgedoc",
        },
    });

    // Default is already "on", but pin it so the guarantee is explicit and a
    // console change shows up as drift rather than silently weakening transport.
    const requireTls = new azurenative.dbforpostgresql.v20240801.Configuration(
        `hedgedoc-pg-require-tls-${env}`,
        {
            configurationName: "require_secure_transport",
            resourceGroupName: resourceGroup.name,
            serverName: server.name,
            value: "on",
            source: "user-override",
        },
        { dependsOn: [server] }
    );

    // Azure denies all inbound by default when no firewall rule exists; each rule
    // below opens exactly one address.
    const firewallRules = config.allowedEgressIps.map((ip, i) =>
        new azurenative.dbforpostgresql.v20240801.FirewallRule(
            `hedgedoc-pg-fw-${env}-${i}`,
            {
                firewallRuleName: `aks-egress-${i}`,
                resourceGroupName: resourceGroup.name,
                serverName: server.name,
                startIpAddress: ip,
                endIpAddress: ip,
            },
            { dependsOn: [server] }
        )
    );

    const database = new azurenative.dbforpostgresql.v20240801.Database(`hedgedoc-db-${env}`, {
        databaseName: config.databaseName,
        resourceGroupName: resourceGroup.name,
        serverName: server.name,
        charset: "UTF8",
        collation: "en_US.utf8",
    }, { dependsOn: [server] });

    const fqdn = pulumi.interpolate`${serverName}.postgres.database.azure.com`;

    // TLS options are supplied through HedgeDoc's config.json rather than an
    // sslmode= query parameter — Sequelize does not reliably map connection-string
    // query parameters onto the pg driver.
    const connectionString = pulumi.secret(
        pulumi.interpolate`postgres://${config.administratorLogin}:${config.administratorPassword}@${fqdn}:5432/${config.databaseName}`
    );

    return {
        resourceGroup,
        server,
        database,
        firewallRules,
        requireTls,
        fqdn,
        connectionString,
        serverName: server.name,
    };
}
