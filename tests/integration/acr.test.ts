/**
 * ACR — Container Registry Live Verification
 *
 * Verifies the Azure Container Registry deployed by Pulumi works end-to-end:
 * - Registry exists and provisioning is Succeeded
 * - Admin credentials are valid (basic auth to ACR REST API)
 * - Can list repositories via the ACR REST API
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

  it("registry exists and provisioningState is Succeeded", async () => {
    const registry = await client.registries.get(resourceGroup, registryName);
    expect(registry.provisioningState).toBe("Succeeded");
  });

  it("admin credentials are valid", () => {
    const output = exec(
      `curl -sf -u "${acrUsername}:${acrPassword}" https://${loginServer}/v2/`
    );
    expect(output).toBeDefined();
  });

  it("can query ACR catalog via REST API", () => {
    const output = exec(
      `curl -sf -u "${acrUsername}:${acrPassword}" https://${loginServer}/v2/_catalog`
    );
    const catalog = JSON.parse(output);
    expect(catalog).toHaveProperty("repositories");
  });
});
