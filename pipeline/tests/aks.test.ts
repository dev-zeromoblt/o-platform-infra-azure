/**
 * AKS Cluster Health — Live infrastructure verification
 *
 * Verifies the AKS cluster deployed by Pulumi is healthy:
 * - Provisioning state is Succeeded
 * - All system node pools are Running
 * - At least 1 Ready node via kubectl
 * - Kubernetes API server responds to /healthz
 */
import { ContainerServiceClient } from "@azure/arm-containerservice";
import { execSync } from "child_process";
import * as https from "https";
import { getAzureCredential, subscriptionId, stackOutput, kubectl } from "./helpers";

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
    console.log(`✓ AKS cluster ${clusterName} provisioningState: ${cluster.provisioningState}`);
  });

  it("all system node pools are Running", async () => {
    const poolList = client.agentPools.list(resourceGroup, clusterName);
    const pools: string[] = [];
    for await (const pool of poolList) {
      expect(pool.provisioningState).toBe("Succeeded");
      pools.push(pool.name!);
    }
    expect(pools.length).toBeGreaterThan(0);
    console.log(`✓ Node pools verified: ${pools.join(", ")}`);
  });

  it("at least 1 node is Ready", () => {
    const output = kubectl("get nodes --no-headers");
    const readyNodes = output.split("\n").filter(line => line.includes("Ready")).length;
    expect(readyNodes).toBeGreaterThan(0);
    console.log(`✓ Ready nodes: ${readyNodes}`);
  });

  it("Kubernetes API server healthz returns ok", async () => {
    const output = kubectl("get --raw /healthz");
    expect(output.trim()).toBe("ok");
    console.log("✓ Kubernetes API /healthz: ok");
  });
});
