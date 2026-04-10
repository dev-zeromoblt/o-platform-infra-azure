/**
 * Workload Identity — Live Verification
 *
 * Verifies OIDC issuer is configured on the cluster for workload identity federation.
 */
import { ContainerServiceClient } from "@azure/arm-containerservice";
import { getAzureCredential, subscriptionId, stackOutput } from "../helpers";

describe("Workload Identity", () => {
  let client: ContainerServiceClient;
  let clusterName: string;
  let resourceGroup: string;

  beforeAll(() => {
    client = new ContainerServiceClient(getAzureCredential(), subscriptionId());
    clusterName = stackOutput("AKSCLUSTERNAME");
    resourceGroup = stackOutput("RESOURCEGROUPNAME");
  });

  it("OIDC issuer is enabled on the cluster", async () => {
    const cluster = await client.managedClusters.get(resourceGroup, clusterName);
    expect(cluster.oidcIssuerProfile?.enabled).toBe(true);
    expect(cluster.oidcIssuerProfile?.issuerURL).toBeDefined();
    expect(cluster.oidcIssuerProfile!.issuerURL!.length).toBeGreaterThan(0);
  });

  it("workload identity is enabled on the cluster", async () => {
    const cluster = await client.managedClusters.get(resourceGroup, clusterName);
    expect(cluster.securityProfile?.workloadIdentity?.enabled).toBe(true);
  });
});
