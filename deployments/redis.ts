import * as pulumi from "@pulumi/pulumi";
import * as azurenative from "@pulumi/azure-native";
// Pin the cache resources to the 2025-04-01 API: the default RedisEnterprise apiVersion
// (2023-03-01-preview) predates the Azure Managed Redis "Balanced_*" SKUs and rejects them.
import * as cache from "@pulumi/azure-native/cache/v20250401";

export interface RedisConfig {
  resourceGroupName: pulumi.Input<string>;
  environment: string;
  location: string;
  /**
   * Optional resource ID of the AKS cluster VNet to peer with, so pods can reach the
   * Redis private endpoint. AKS Automatic manages its own VNet (in the node resource
   * group) and does not expose it via the cluster object, so this is supplied via config
   * (`az aks show ... --query networkProfile` / the MC_ node RG) once known. When absent,
   * Redis is still provisioned privately; only cross-VNet reachability wiring is deferred.
   */
  aksVnetId?: pulumi.Input<string>;
}

export interface RedisOutputs {
  cluster: cache.RedisEnterprise;
  database: cache.Database;
  hostName: pulumi.Output<string>;
  port: pulumi.Output<number>;
  primaryKey: pulumi.Output<string>;
  vnetId: pulumi.Output<string>;
}

/**
 * Azure Managed Redis (RedisEnterprise) for the mobility service — private to the cluster.
 *
 * Uses `Microsoft.Cache/redisEnterprise` because classic Azure Cache for Redis
 * (`Microsoft.Cache/Redis`, Basic/Standard/Premium) is being retired.
 *
 * It is *just a cache*, written and read only by the mobility service (single writer per
 * domain after the whole-domain migration). Not shared with Lambda, no public exposure.
 *
 * SKU: dev = Balanced_B0 (smallest AMR tier); beta/prod = Balanced_B1 (HA is built in).
 * Access is private-only: reached via a Private Endpoint in a dedicated VNet with the
 * `privatelink.redisenterprise.cache.azure.net` private DNS zone. Peer that VNet to the AKS
 * VNet (aksVnetId) for pod reachability.
 */
export function createRedis(config: RedisConfig): RedisOutputs {
  const { resourceGroupName, environment, location, aksVnetId } = config;
  const isProd = environment !== "dev";

  // ── Dedicated VNet + subnet for the private endpoint ──────────────────────
  const vnet = new azurenative.network.VirtualNetwork(`redis-vnet-${environment}`, {
    virtualNetworkName: `${environment}-redis-vnet`,
    resourceGroupName,
    location,
    addressSpace: { addressPrefixes: ["10.42.0.0/24"] },
    tags: { environment, managedBy: "pulumi", purpose: "mobility-redis" },
  });

  const peSubnet = new azurenative.network.Subnet(`redis-pe-subnet-${environment}`, {
    subnetName: "private-endpoints",
    resourceGroupName,
    virtualNetworkName: vnet.name,
    addressPrefix: "10.42.0.0/27",
    privateEndpointNetworkPolicies: "Disabled",
  });

  // ── The cache: Azure Managed Redis (RedisEnterprise cluster + default database) ──
  const cluster = new cache.RedisEnterprise(`redis-${environment}`, {
    clusterName: `${environment}-mobility-redis`,
    resourceGroupName,
    location,
    sku: { name: isProd ? "Balanced_B1" : "Balanced_B0" },
    minimumTlsVersion: "1.2",
    tags: { environment, managedBy: "pulumi", purpose: "mobility-cache" },
  });

  const database = new cache.Database(`redis-db-${environment}`, {
    databaseName: "default", // AMR requires the database be named "default"
    clusterName: cluster.name,
    resourceGroupName,
    clientProtocol: "Encrypted", // TLS only
    clusteringPolicy: "EnterpriseCluster", // single endpoint — drop-in for a standard client
    evictionPolicy: "AllKeysLRU", // it's a cache: evict cold keys under memory pressure
  });

  // ── Private DNS zone for the privatelink hostname ─────────────────────────
  const dnsZone = new azurenative.network.PrivateZone(`redis-dns-${environment}`, {
    privateZoneName: "privatelink.redisenterprise.cache.azure.net",
    resourceGroupName,
    location: "global",
    tags: { environment, managedBy: "pulumi" },
  });

  new azurenative.network.VirtualNetworkLink(`redis-dns-link-${environment}`, {
    virtualNetworkLinkName: `${environment}-redis-vnet-link`,
    privateZoneName: dnsZone.name,
    resourceGroupName,
    location: "global",
    registrationEnabled: false,
    virtualNetwork: { id: vnet.id },
  });

  // ── Private endpoint into the dedicated subnet ────────────────────────────
  const privateEndpoint = new azurenative.network.PrivateEndpoint(`redis-pe-${environment}`, {
    privateEndpointName: `${environment}-redis-pe`,
    resourceGroupName,
    location,
    subnet: { id: peSubnet.id },
    privateLinkServiceConnections: [
      {
        name: `${environment}-redis-plsc`,
        privateLinkServiceId: cluster.id,
        groupIds: ["redisEnterprise"],
      },
    ],
  });

  new azurenative.network.PrivateDnsZoneGroup(`redis-pe-dns-${environment}`, {
    privateDnsZoneGroupName: "default",
    resourceGroupName,
    privateEndpointName: privateEndpoint.name,
    privateDnsZoneConfigs: [
      { name: "redis-config", privateDnsZoneId: dnsZone.id },
    ],
  });

  // ── Optional peering to the AKS VNet for pod reachability ─────────────────
  if (aksVnetId) {
    new azurenative.network.VirtualNetworkPeering(`redis-to-aks-peering-${environment}`, {
      virtualNetworkPeeringName: `${environment}-redis-to-aks`,
      resourceGroupName,
      virtualNetworkName: vnet.name,
      remoteVirtualNetwork: { id: aksVnetId },
      allowVirtualNetworkAccess: true,
      allowForwardedTraffic: false,
      allowGatewayTransit: false,
      useRemoteGateways: false,
    });
    // NOTE: the reverse peering (AKS VNet → redis VNet) and linking this private DNS zone
    // to the AKS VNet must also be created for pods to resolve + route. Because the AKS
    // Automatic VNet lives in the managed node resource group, that half is applied once
    // its VNet id is known (see aksVnetId doc) — tracked in ORG-40.
  }

  // ── Access key (secret) ───────────────────────────────────────────────────
  // Gate the listDatabaseKeys invoke on database.id, which is UNKNOWN during preview for a
  // to-be-created resource — so the apply is skipped at preview instead of calling Azure
  // (which would 404 before the database exists).
  const primaryKey = pulumi
    .all([database.id, resourceGroupName, cluster.name])
    .apply(([, rgName, clusterName]) =>
      cache.listDatabaseKeys({
        resourceGroupName: rgName,
        clusterName,
        databaseName: "default",
      })
    )
    .apply((keys) => keys.primaryKey!);

  return {
    cluster,
    database,
    hostName: cluster.hostName,
    port: database.port.apply((p) => p ?? 10000),
    primaryKey,
    vnetId: vnet.id,
  };
}
