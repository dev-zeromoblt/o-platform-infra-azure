/**
 * ACR — Container Registry Live Verification
 *
 * Verifies the Azure Container Registry deployed by Pulumi works end-to-end:
 * - Registry exists and provisioning is Succeeded
 * - Admin credentials are valid (login succeeds)
 * - Can push and pull a test image
 */
import { ContainerRegistryManagementClient } from "@azure/arm-containerregistry";
import { execSync } from "child_process";
import { getAzureCredential, subscriptionId, stackOutput } from "./helpers";

const exec = (cmd: string) => execSync(cmd, { encoding: "utf-8", stdio: "pipe" });

describe("ACR — Container Registry", () => {
  let client: ContainerRegistryManagementClient;
  let loginServer: string;
  let acrUsername: string;
  let acrPassword: string;
  let resourceGroup: string;
  const testImage = "pipeline-test:latest";

  beforeAll(() => {
    client = new ContainerRegistryManagementClient(getAzureCredential(), subscriptionId());
    loginServer = stackOutput("ACRLOGINSERVER");
    acrUsername = stackOutput("ACRUSERNAME");
    acrPassword = stackOutput("ACRPASSWORD");
    resourceGroup = stackOutput("RESOURCEGROUPNAME");
  });

  afterAll(() => {
    // Cleanup test image from ACR
    try {
      exec(`az acr repository delete --name ${loginServer.split(".")[0]} --image ${testImage} --yes 2>/dev/null || true`);
      console.log("✓ Test image cleaned up");
    } catch {}
  });

  it("registry exists and provisioningState is Succeeded", async () => {
    const registryName = loginServer.split(".")[0];
    const registry = await client.registries.get(resourceGroup, registryName);
    expect(registry.provisioningState).toBe("Succeeded");
    console.log(`✓ ACR ${registryName} provisioningState: ${registry.provisioningState}`);
  });

  it("Docker login to ACR succeeds", () => {
    exec(`echo "${acrPassword}" | docker login ${loginServer} --username ${acrUsername} --password-stdin`);
    console.log(`✓ Docker login to ${loginServer} succeeded`);
  });

  it("can push and pull a test image", () => {
    const fullImage = `${loginServer}/${testImage}`;

    // Pull a tiny base image, retag, push to ACR
    exec("docker pull busybox:latest");
    exec(`docker tag busybox:latest ${fullImage}`);
    exec(`docker push ${fullImage}`);
    console.log(`✓ Pushed ${fullImage}`);

    // Pull it back
    exec(`docker pull ${fullImage}`);
    console.log(`✓ Pulled ${fullImage}`);
  });
});
