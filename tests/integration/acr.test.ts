/**
 * ACR — Container Registry Live Verification
 *
 * Verifies the Azure Container Registry deployed by Pulumi works end-to-end:
 * - Registry exists and provisioning is Succeeded
 * - Admin credentials are valid (az acr login succeeds)
 * - Can import a test image via az acr import
 */
import { ContainerRegistryManagementClient } from "@azure/arm-containerregistry";
import { getAzureCredential, subscriptionId, stackOutput, exec } from "../helpers";

describe("ACR — Container Registry", () => {
  let client: ContainerRegistryManagementClient;
  let loginServer: string;
  let acrUsername: string;
  let acrPassword: string;
  let resourceGroup: string;
  let registryName: string;

  beforeAll(() => {
    client = new ContainerRegistryManagementClient(getAzureCredential(), subscriptionId());
    loginServer = stackOutput("ACRLOGINSERVER");
    acrUsername = stackOutput("ACRUSERNAME");
    acrPassword = stackOutput("ACRPASSWORD");
    resourceGroup = stackOutput("RESOURCEGROUPNAME");
    registryName = loginServer.split(".")[0];
  });

  afterAll(() => {
    try {
      exec(`az acr repository delete --name ${registryName} --repository pipeline-test --yes 2>/dev/null || true`);
    } catch {
      // cleanup is best-effort
    }
  });

  it("registry exists and provisioningState is Succeeded", async () => {
    const registry = await client.registries.get(resourceGroup, registryName);
    expect(registry.provisioningState).toBe("Succeeded");
  });

  it("ACR login succeeds with admin credentials", () => {
    exec(`az acr login --name ${registryName} --username ${acrUsername} --password ${acrPassword}`);
  });

  it("can import a test image into ACR", () => {
    exec(
      `az acr import --name ${registryName} --source docker.io/library/busybox:latest --image pipeline-test:ci --force`
    );
    const output = exec(`az acr repository show --name ${registryName} --repository pipeline-test -o tsv --query name`);
    expect(output.trim()).toBe("pipeline-test");
  });
});
