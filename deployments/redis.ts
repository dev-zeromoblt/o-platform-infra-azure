import * as pulumi from "@pulumi/pulumi";
import * as azurenative from "@pulumi/azure-native";

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
  cache: azurenative.cache.Redis;
  hostName: pulumi.Output<string>;
  sslPort: pulumi.Output<number>;
  primaryKey: pulumi.Output<string>;
  vnetId: pulumi.Output<string>;
}

/**
 * Managed Azure Cache for Redis for the mobility service — private to the cluster.
 *
 * It is *just a cache*, written and read only by the mobility service (single writer per
 * domain after the whole-domain migration). Not shared with Lambda, no public exposure.
 *
 * SKU: dev = Basic C0 (single node, cheapest); beta/prod = Standard C1 (replicated, HA).
 * Access is private-only: public network access disabled, reached via a Private Endpoint
 * in a dedicated VNet with a privatelink private DNS zone. Peer that VNet to the AKS VNet
 * (aksVnetId) for pod reachability.
 */
export function createRedis(config: RedisConfig): RedisOutputs {
  const { resourceGroupName, environment, location, aksVnetId } = config;
  const isProd = environment !== "dev";

  // ── Dedicated VNet + subnet for the private endpoint ──────────────────────
  // AKS Automatic runs in its own managed VNet; we host the private endpoint in a
  // small dedicated VNet and peer it to the cluster.
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

  // ── The cache ─────────────────────────────────────────────────────────────
  const cache = new azurenative.cache.Redis(`redis-${environment}`, {
    name: `${environment}-mobility-redis`,
    resourceGroupName,
    location,
    sku: {
      name: isProd ? "Standard" : "Basic",
      family: "C",
      capacity: isProd ? 1 : 0,
    },
    minimumTlsVersion: "1.2",
    enableNonSslPort: false,
    redisVersion: "6",
    publicNetworkAccess: "Disabled",
    tags: { environment, managedBy: "pulumi", purpose: "mobility-cache" },
  });

  // ── Private DNS zone for the privatelink hostname ─────────────────────────
  const dnsZone = new azurenative.network.PrivateZone(`redis-dns-${environment}`, {
    privateZoneName: "privatelink.redis.cache.windows.net",
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
        privateLinkServiceId: cache.id,
        groupIds: ["redisCache"],
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
  // Read the key off the resource's own output, NOT the listRedisKeys invoke — the
  // invoke runs eagerly at preview time and 404s before the cache exists. The resource
  // output is "unknown" during preview, so the apply is skipped instead.
  const primaryKey = cache.accessKeys.apply((keys) => keys.primaryKey);

  return {
    cache,
    hostName: cache.hostName,
    sslPort: cache.sslPort.apply((p) => p ?? 6380),
    primaryKey,
    vnetId: vnet.id,
  };
}
