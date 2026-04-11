/**
 * ACR — Container Registry Live Verification
 *
 * Verifies the Azure Container Registry deployed by Pulumi works end-to-end:
 * - Registry exists and provisioning is Succeeded
 * - Admin credentials can obtain an access token
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

  it("admin credentials can obtain an access token", () => {
    const output = exec(
      `az acr login --name ${registryName} --expose-token --username ${acrUsername} --password ${acrPassword} --output tsv --query accessToken`
    );
    expect(output.trim().length).toBeGreaterThan(0);
  });

  it("can query ACR catalog via REST API", () => {
    const token = exec(
      `az acr login --name ${registryName} --expose-token --username ${acrUsername} --password ${acrPassword} --output tsv --query accessToken`
    ).trim();
    const output = exec(
      `curl -s -H "Authorization: Bearer ${token}" https://${loginServer}/v2/_catalog`
    );
    const catalog = JSON.parse(output);
    expect(catalog).toHaveProperty("repositories");
  });
});
