/**
 * AKS Cluster Health — Live infrastructure verification
 *
 * Verifies the AKS cluster deployed by Pulumi is healthy:
 * - Provisioning state is Succeeded
 * - All node pools are in Succeeded state
 * - At least 1 Ready node via kubectl
 * - Kubernetes API server responds to /healthz
 */
import { ContainerServiceClient } from "@azure/arm-containerservice";
import { getAzureCredential, subscriptionId, stackOutput, kubectl } from "../helpers";

describe("AKS Cluster Health", () => {
  let client: ContainerServiceClient;
  let clusterName: string;
  let resourceGroup: string;

  beforeAll(() => {
    client = new ContainerServiceClient(getAzureCredential(), subscriptionId());
    clusterName = stackOutput("AKSCLUSTERNAME");
    resourceGroup = stackOutput("RESOURCEGROUPNAME");
  });

  it("cluster exists and provisioningState is Succeeded", async () => {
    const cluster = await client.managedClusters.get(resourceGroup, clusterName);
    expect(cluster.provisioningState).toBe("Succeeded");
  });

  it("all node pools are in Succeeded state", async () => {
    const poolList = client.agentPools.list(resourceGroup, clusterName);
    const pools: string[] = [];
    for await (const pool of poolList) {
      expect(pool.provisioningState).toBe("Succeeded");
      pools.push(pool.name!);
    }
    expect(pools.length).toBeGreaterThan(0);
  });

  it("at least 1 node is Ready", () => {
    const output = kubectl("get nodes --no-headers");
    const readyNodes = output.split("\n").filter((line) => line.includes("Ready")).length;
    expect(readyNodes).toBeGreaterThan(0);
  });

  it("Kubernetes API server healthz returns ok", () => {
    const output = kubectl("get --raw /healthz");
    expect(output.trim()).toBe("ok");
  });
});
