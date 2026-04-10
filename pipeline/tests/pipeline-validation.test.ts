/**
 * Pipeline Validation — Static Tests (runs on every PR, no Azure credentials needed)
 *
 * Validates pipeline YAML structure and template correctness.
 */
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

const PIPELINE_DIR = path.join(__dirname, "..");

const loadYaml = (relPath: string) =>
  yaml.parse(fs.readFileSync(path.join(PIPELINE_DIR, relPath), "utf8"));

describe("Pipeline YAML Syntax", () => {
  const files = [
    "pipeline_def.yaml",
    "templates/pulumi-deploy.yml",
    "templates/deploy-stage.yml",
    "templates/infra-verify.yml",
    "scripts/setup-environment.yml",
  ];

  files.forEach(file => {
    it(`${file} parses without errors`, () => {
      const content = fs.readFileSync(path.join(PIPELINE_DIR, file), "utf8");
      expect(() => yaml.parse(content)).not.toThrow();
    });
  });
});

describe("Pipeline Structure", () => {
  let pipeline: any;

  beforeAll(() => {
    pipeline = loadYaml("pipeline_def.yaml");
  });

  it("triggers on main branch", () => {
    expect(pipeline.trigger?.branches?.include).toContain("main");
  });

  it("has all required stages", () => {
    const stages = pipeline.stages.map((s: any) => s.stage);
    expect(stages).toContain("Validate");
    expect(stages).toContain("Beta");
    expect(stages).toContain("ProdApproval");
    expect(stages).toContain("Prod");
    expect(stages).toContain("Notify");
  });

  it("Beta stage has no dependencies (runs first after Validate)", () => {
    const beta = pipeline.stages.find((s: any) => s.stage === "Beta");
    expect(beta.dependsOn).toEqual([]);
  });

  it("ProdApproval depends on Beta", () => {
    const approval = pipeline.stages.find((s: any) => s.stage === "ProdApproval");
    expect(approval.dependsOn).toContain("Beta");
  });

  it("Prod depends on ProdApproval", () => {
    const prod = pipeline.stages.find((s: any) => s.stage === "Prod");
    expect(prod.dependsOn).toContain("ProdApproval");
  });

  it("Notify has condition: always()", () => {
    const notify = pipeline.stages.find((s: any) => s.stage === "Notify");
    expect(notify.condition).toBe("always()");
  });
});

describe("Template Parameters", () => {
  it("pulumi-deploy.yml has required parameters", () => {
    const template = loadYaml("templates/pulumi-deploy.yml");
    const params = template.parameters.map((p: any) => p.name);
    expect(params).toContain("stack");
    expect(params).toContain("environment");
    expect(params).toContain("subscriptionId");
    expect(params).toContain("workingDirectory");
  });

  it("pulumi-deploy.yml has rollback step on failure", () => {
    const template = loadYaml("templates/pulumi-deploy.yml");
    const rollback = template.steps.find(
      (s: any) => s.condition === "failed()" && s.displayName?.includes("Rollback")
    );
    expect(rollback).toBeDefined();
    expect(rollback.script).toContain("pulumi cancel");
    expect(rollback.script).toContain("pulumi refresh");
  });

  it("pulumi-deploy.yml publishes deployment artifacts", () => {
    const template = loadYaml("templates/pulumi-deploy.yml");
    const artifacts = template.steps.filter((s: any) => s.task === "PublishBuildArtifacts@1");
    expect(artifacts.length).toBeGreaterThanOrEqual(2);
  });

  it("infra-verify.yml publishes JUnit test results", () => {
    const template = loadYaml("templates/infra-verify.yml");
    const publish = template.steps.find(
      (s: any) => s.task === "PublishTestResults@2"
    );
    expect(publish).toBeDefined();
    expect(publish.inputs?.testResultsFormat).toBe("JUnit");
    expect(publish.inputs?.failTaskOnFailedTests).toBe(true);
  });

  it("deploy-stage.yml supports optional approval gate", () => {
    const template = loadYaml("templates/deploy-stage.yml");
    const params = template.parameters.map((p: any) => p.name);
    expect(params).toContain("requiresApproval");
    expect(params).toContain("approvalTimeout");
  });
});

describe("Scripts", () => {
  it("setup-environment.sh exists and checks required env vars", () => {
    const script = fs.readFileSync(
      path.join(PIPELINE_DIR, "scripts/setup-environment.sh"),
      "utf8"
    );
    expect(script).toContain("#!/bin/bash");
    expect(script).toContain("AZURE_CLIENT_ID");
    expect(script).toContain("AZURE_CLIENT_SECRET");
    expect(script).toContain("PULUMI_ACCESS_TOKEN");
  });
});
