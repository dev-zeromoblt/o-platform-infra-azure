import * as pulumi from "@pulumi/pulumi";
import * as azurenative from "@pulumi/azure-native";

export interface AcrConfig {
  resourceGroupName: pulumi.Input<string>;
  environment: string;
  location: string;
}

export interface AcrOutputs {
  registry: azurenative.containerregistry.Registry;
  loginServer: pulumi.Output<string>;
  username: pulumi.Output<string>;
  password: pulumi.Output<string>;
}

/**
 * Creates an Azure Container Registry for the environment
 *
 * ACR naming convention: otime<env>acr (e.g., otimedevacr, otimebetaacr, otimeprodacr)
 * Must be globally unique, lowercase alphanumeric only
 */
export function createAcr(config: AcrConfig): AcrOutputs {
  const { resourceGroupName, environment, location } = config;

  // Create ACR name (must be globally unique, lowercase alphanumeric)
  // Format: otime<env>acr (e.g., otimedevacr, otimebetaacr, otimeprodacr)
  const acrName = `otime${environment}acr`;

  // Determine SKU based on environment
  // Basic: Dev environment (cost-effective, suitable for development)
  // Standard: Beta/Prod (better performance, webhook support)
  const sku = environment === "dev" ? "Basic" : "Standard";

  // Create Azure Container Registry
  const registry = new azurenative.containerregistry.Registry(
    `acr-${environment}`,
    {
      registryName: acrName,
      resourceGroupName: resourceGroupName,
      location: location,
      sku: {
        name: sku,
      },
      adminUserEnabled: true, // Enable admin user for pulling images
      publicNetworkAccess: "Enabled",
      tags: {
        environment: environment,
        managedBy: "pulumi",
        purpose: "container-registry",
      },
    }
  );

  // Get ACR credentials
  const credentials = pulumi
    .all([resourceGroupName, registry.name])
    .apply(([rgName, registryName]) =>
      azurenative.containerregistry.listRegistryCredentials({
        resourceGroupName: rgName,
        registryName: registryName,
      })
    );

  // Extract login server, username, and password
  const loginServer = registry.loginServer;
  const username = credentials.apply((creds) => creds.username!);
  const password = credentials.apply(
    (creds) => creds.passwords![0].value!
  );

  return {
    registry,
    loginServer,
    username,
    password,
  };
}
