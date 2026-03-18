import * as pulumi from "@pulumi/pulumi";
import * as azurenative from "@pulumi/azure-native";

export interface DnsConfig {
    environment: string;
    domain: string;
    location: string;
}

export function createDnsZone(config: DnsConfig) {
    // Create separate resource group for DNS (lifecycle management)
    const dnsResourceGroup = new azurenative.resources.ResourceGroup(`dns-rg-${config.environment}`, {
        location: config.location,
        resourceGroupName: `dns-rg-${config.environment}`,
        tags: {
            environment: config.environment,
            managedBy: "pulumi",
        },
    });

    // Create Azure DNS zone
    const dnsZone = new azurenative.network.Zone(`dns-zone-${config.environment}`, {
        resourceGroupName: dnsResourceGroup.name,
        zoneName: config.domain,
        location: "global", // DNS zones are global
        zoneType: "Public",
        tags: {
            environment: config.environment,
            managedBy: "pulumi",
        },
    });

    return {
        resourceGroup: dnsResourceGroup,
        zone: dnsZone,
        nameServers: dnsZone.nameServers,
        zoneName: dnsZone.name,
    };
}

export function createDnsARecord(
    zoneName: pulumi.Input<string>,
    resourceGroupName: pulumi.Input<string>,
    name: string,
    ipAddress: pulumi.Input<string>,
    environment: string
) {
    return new azurenative.network.RecordSet(`dns-a-${name}-${environment}`, {
        resourceGroupName: resourceGroupName,
        zoneName: zoneName,
        relativeRecordSetName: name === "@" ? "@" : name,
        recordType: "A",
        ttl: 300,
        aRecords: [{
            ipv4Address: ipAddress,
        }],
        tags: {
            environment: environment,
            managedBy: "pulumi",
        },
    });
}
