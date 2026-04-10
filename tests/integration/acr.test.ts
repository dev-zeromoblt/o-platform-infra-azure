/**
 * ACR — Container Registry Live Verification
 *
 * Verifies the Azure Container Registry deployed by Pulumi works end-to-end:
 * - Registry exists and provisioning is Succeeded
 * - Admin credentials are valid (login succeeds)
 * - Can push and pull a test image
 */
import { ContainerRegistryManagementClient } from "@azure/arm-containerregistry";
import { getAzureCredential, subscriptionId, stackOutput, exec } from "../helpers";

describe("ACR — Container Registry", () => {
  let client: ContainerRegistryManagementClient;
  let loginServer: string;
  let acrUsername: string;
  let acrPassword: string;
  let resourceGroup: string;
  const testImage = "pipeline-test:ci";

  beforeAll(() => {
    client = new ContainerRegistryManagementClient(getAzureCredential(), subscriptionId());
    loginServer = stackOutput("ACRLOGINSERVER");
    acrUsername = stackOutput("ACRUSERNAME");
    acrPassword = stackOutput("ACRPASSWORD");
    resourceGroup = stackOutput("RESOURCEGROUPNAME");
  });

  afterAll(() => {
    try {
      exec(`az acr repository delete --name ${loginServer.split(".")[0]} --image ${testImage} --yes 2>/dev/null || true`);
    } catch {
      // cleanup is best-effort
    }
  });

  it("registry exists and provisioningState is Succeeded", async () => {
    const registryName = loginServer.split(".")[0];
    const registry = await client.registries.get(resourceGroup, registryName);
    expect(registry.provisioningState).toBe("Succeeded");
  });

  it("Docker login to ACR succeeds", () => {
    exec(`echo "${acrPassword}" | docker login ${loginServer} --username ${acrUsername} --password-stdin`);
  });

  it("can push and pull a test image", () => {
    const fullImage = `${loginServer}/${testImage}`;
    exec("docker pull busybox:latest");
    exec(`docker tag busybox:latest ${fullImage}`);
    exec(`docker push ${fullImage}`);
    exec(`docker pull ${fullImage}`);
  });
});
