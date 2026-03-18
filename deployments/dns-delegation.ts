import * as pulumi from "@pulumi/pulumi";
import * as azurenative from "@pulumi/azure-native";

export interface DnsDelegationConfig {
    parentZoneName: pulumi.Input<string>;
    parentResourceGroupName: pulumi.Input<string>;
    subdomain: string; // e.g., "dev.az" for dev.az.zeromoblt.com
    nameServers: pulumi.Input<string[]>;
    environment: string;
}

/**
 * Creates NS records in the parent DNS zone to delegate a subdomain
 * to another DNS zone (typically in another environment)
 */
export function createDnsDelegation(config: DnsDelegationConfig) {
    // Create NS record set for subdomain delegation
    const nsRecordSet = new azurenative.network.RecordSet(
        `dns-ns-${config.subdomain}-${config.environment}`,
        {
            resourceGroupName: config.parentResourceGroupName,
            zoneName: config.parentZoneName,
            relativeRecordSetName: config.subdomain,
            recordType: "NS",
            ttl: 300,
            nsRecords: pulumi.output(config.nameServers).apply(servers =>
                servers.map(server => ({ nsdname: server }))
            ),
        }
    );

    return nsRecordSet;
}
