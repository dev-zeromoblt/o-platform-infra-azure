import * as fs from "fs";
import * as path from "path";

describe("Project Validation", () => {
  const rootDir = path.resolve(__dirname, "../..");

  it("Pulumi.yaml exists and has correct project name", () => {
    const content = fs.readFileSync(path.join(rootDir, "Pulumi.yaml"), "utf-8");
    expect(content).toContain("name: o-platform-infra-azure");
    expect(content).toContain("runtime:");
  });

  it("all stack config files exist", () => {
    const stacks = ["dev", "beta", "prod"];
    for (const stack of stacks) {
      const filePath = path.join(rootDir, `Pulumi.${stack}.yaml`);
      expect(fs.existsSync(filePath)).toBe(true);
    }
  });

  it("each stack config has required keys", () => {
    const stacks = ["dev", "beta", "prod"];
    const requiredKeys = ["environment", "kubernetesVersion", "domain", "systemPoolVmSize"];
    for (const stack of stacks) {
      const content = fs.readFileSync(path.join(rootDir, `Pulumi.${stack}.yaml`), "utf-8");
      for (const key of requiredKeys) {
        expect(content).toContain(key);
      }
    }
  });

  it("TypeScript compiles without errors", () => {
    const tsconfigPath = path.join(rootDir, "tsconfig.json");
    expect(fs.existsSync(tsconfigPath)).toBe(true);
  });

  it("all deployment modules are importable files", () => {
    const deploymentsDir = path.join(rootDir, "deployments");
    const expectedModules = [
      "cluster.ts",
      "acr.ts",
      "dns-zones.ts",
      "dns-delegation.ts",
      "ingress-controller.ts",
      "cert-manager.ts",
      "karpenter-patches.ts",
    ];
    for (const mod of expectedModules) {
      expect(fs.existsSync(path.join(deploymentsDir, mod))).toBe(true);
    }
  });

  it("index.ts exports expected stack outputs", () => {
    const content = fs.readFileSync(path.join(rootDir, "index.ts"), "utf-8");
    const expectedExports = [
      "resourceGroupName",
      "aksClusterName",
      "kubeconfig",
      "ingressControllerIP",
      "dnsZoneName",
      "acrLoginServer",
    ];
    for (const exp of expectedExports) {
      expect(content).toContain(exp);
    }
  });
});
