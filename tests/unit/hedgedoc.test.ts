import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";

const rootDir = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(rootDir, p), "utf-8");

// Mocks must be installed before any resource is constructed.
pulumi.runtime.setMocks({
  newResource: (args: pulumi.runtime.MockResourceArgs) => ({
    id: `${args.name}_id`,
    state: args.inputs,
  }),
  call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
});

/** Resolve an Output (including secrets) to a plain value. */
function val<T>(o: pulumi.Output<T> | undefined): Promise<T | undefined> {
  if (o === undefined) return Promise.resolve(undefined);
  return new Promise(resolve => {
    o.apply(v => { resolve(v); return v; });
  });
}

/* eslint-disable @typescript-eslint/no-var-requires */
const { createHedgeDocDatabase } = require("../../deployments/hedgedoc-database");
const { createHedgeDoc } = require("../../deployments/hedgedoc");
const k8s = require("@pulumi/kubernetes");

const DB_ARGS = {
  environment: "test",
  location: "centralindia",
  allowedEgressIps: ["104.211.98.71"],
  administratorLogin: "hedgedocadmin",
  administratorPassword: pulumi.secret("admin-pw"),
  appUser: "hedgedoc_app",
  appPassword: pulumi.secret("app-pw"),
  databaseName: "hedgedoc",
  postgresVersion: "16",
  skuName: "Standard_B2s",
  skuTier: "Burstable",
  storageSizeGB: 32,
  backupRetentionDays: 14,
  highAvailability: false,
};

describe("HedgeDoc database (BALL-46)", () => {
  describe("firewall — asserted on the synthesized resource, not the source text", () => {
    it("opens exactly the configured egress address, as a single-address range", async () => {
      const db = createHedgeDocDatabase({ ...DB_ARGS });
      expect(db.firewallRules).toHaveLength(1);
      const start = await val(db.firewallRules[0].startIpAddress);
      const end = await val(db.firewallRules[0].endIpAddress);
      expect(start).toBe("104.211.98.71");
      expect(end).toBe("104.211.98.71");
    });

    it("rejects 0.0.0.0, which is how Azure spells 'any Azure service'", () => {
      expect(() => createHedgeDocDatabase({ ...DB_ARGS, allowedEgressIps: ["0.0.0.0"] }))
        .toThrow(/beyond the cluster egress address/);
    });

    it("rejects a CIDR or any non-plain-IPv4 value", () => {
      expect(() => createHedgeDocDatabase({ ...DB_ARGS, allowedEgressIps: ["0.0.0.0/0"] }))
        .toThrow(/not a plain IPv4 address/);
    });

    it("rejects an empty allow-list rather than silently producing no rules", () => {
      expect(() => createHedgeDocDatabase({ ...DB_ARGS, allowedEgressIps: [] }))
        .toThrow(/must not be empty/);
    });
  });

  describe("least privilege", () => {
    it("hands the app the dedicated role, never the server administrator", async () => {
      const db = createHedgeDocDatabase({ ...DB_ARGS });
      const conn = await val(db.connectionString) as string;
      expect(conn).toContain("postgres://hedgedoc_app:app-pw@");
      expect(conn).not.toContain("hedgedocadmin");
      expect(conn).not.toContain("admin-pw");
    });
  });

  describe("server configuration", () => {
    it("enforces TLS in transit explicitly", async () => {
      const db = createHedgeDocDatabase({ ...DB_ARGS });
      expect(await val(db.requireTls.configurationName)).toBe("require_secure_transport");
      expect(await val(db.requireTls.value)).toBe("on");
    });

    it("keeps backups on", async () => {
      const db = createHedgeDocDatabase({ ...DB_ARGS });
      const backup = await val(db.server.backup) as { backupRetentionDays?: number } | undefined;
      expect(backup?.backupRetentionDays).toBe(14);
    });
  });
});

describe("HedgeDoc workload (BALL-46)", () => {
  const provider = new k8s.Provider("test-provider", { kubeconfig: "{}" });
  const namespace = new k8s.core.v1.Namespace("test-ns", {
    metadata: { name: "hedgedoc-test" },
  }, { provider });

  const app = createHedgeDoc({
    provider,
    environment: "test",
    namespace,
    domain: "docs.example.com",
    image: "quay.io/hedgedoc/hedgedoc:1.11.1@sha256:" + "0".repeat(64),
    dbConnectionString: pulumi.secret("postgres://hedgedoc_app:app-pw@host:5432/hedgedoc"),
    sessionSecret: pulumi.secret("session"),
    googleClientId: pulumi.secret("cid"),
    googleClientSecret: pulumi.secret("csec"),
    googleHostedDomain: "zeromoblt.com",
    uploadsStorageSize: "20Gi",
    uploadsStorageClass: "managed-csi",
    cpuRequest: "500m",
    cpuLimit: "2",
    memoryRequest: "768Mi",
    memoryLimit: "2Gi",
  });

  // The Deployment spec is deeply nested generated typing; assertions below index
  // into it directly, so a permissive shape keeps the tests readable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spec = () => val(app.deployment.spec) as Promise<any>;

  describe("single-instance constraint", () => {
    // HedgeDoc 1.x keeps realtime note state in process memory. Running more than
    // one replica against one database corrupts notes:
    // https://docs.hedgedoc.org/faq/
    it("runs exactly one replica", async () => {
      expect((await spec()).replicas).toBe(1);
    });

    it("uses Recreate, so a rollout never has two pods live at once", async () => {
      expect((await spec()).strategy.type).toBe("Recreate");
    });

    it("declares no autoscaler anywhere in the module", () => {
      expect(read("deployments/hedgedoc.ts")).not.toMatch(/HorizontalPodAutoscaler/);
    });
  });

  describe("scheduling", () => {
    it("refuses spot capacity, which would evict live editing state", async () => {
      const terms = (await spec()).template.spec.affinity
        .nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms;
      const expr = terms[0].matchExpressions[0];
      expect(expr.key).toBe("karpenter.sh/capacity-type");
      expect(expr.values).toEqual(["on-demand"]);
    });
  });

  describe("cluster policy compliance", () => {
    it("sets CPU and memory requests (k8sazurev1containerrequests denies otherwise)", async () => {
      const c = (await spec()).template.spec.containers[0];
      expect(c.resources.requests.cpu).toBe("500m");
      expect(c.resources.requests.memory).toBe("768Mi");
    });

    it("declares startup, readiness and liveness probes on /_health", async () => {
      const c = (await spec()).template.spec.containers[0];
      for (const p of [c.startupProbe, c.readinessProbe, c.livenessProbe]) {
        expect(p.httpGet.path).toBe("/_health");
      }
    });

    it("runs unprivileged as the image's non-root uid, with fsGroup for the PVC", async () => {
      const podSpec = (await spec()).template.spec;
      expect(podSpec.securityContext.runAsNonRoot).toBe(true);
      expect(podSpec.securityContext.runAsUser).toBe(10000);
      expect(podSpec.securityContext.fsGroup).toBe(10000);
      expect(podSpec.containers[0].securityContext.allowPrivilegeEscalation).toBe(false);
    });

    it("pins the image by digest", async () => {
      expect((await spec()).template.spec.containers[0].image).toMatch(/@sha256:[0-9a-f]{64}$/);
    });
  });

  describe("access control", () => {
    it("carries no server-administrator credentials into the pod", async () => {
      const data = await val(app.secret.stringData) as Record<string, string>;
      expect(data.CMD_DB_URL).toContain("hedgedoc_app");
      expect(data.CMD_DB_URL).not.toContain("hedgedocadmin");
      expect(Object.keys(data)).not.toContain("PGPASSWORD");
    });

    it("is closed to anonymous users and to self-registration", async () => {
      const envs = (await spec()).template.spec.containers[0].env as Array<{ name: string; value: string }>;
      const byName = Object.fromEntries(envs.map(e => [e.name, e.value]));
      expect(byName.CMD_ALLOW_ANONYMOUS).toBe("false");
      expect(byName.CMD_ALLOW_EMAIL_REGISTER).toBe("false");
      expect(byName.CMD_EMAIL).toBe("false");
      expect(byName.CMD_GOOGLE_HOSTEDDOMAIN).toBe("zeromoblt.com");
    });

    it("pairs CMD_ALLOW_FREEURL with authentication", async () => {
      const envs = (await spec()).template.spec.containers[0].env as Array<{ name: string; value: string }>;
      const byName = Object.fromEntries(envs.map(e => [e.name, e.value]));
      if (byName.CMD_ALLOW_FREEURL === "true") {
        expect(byName.CMD_REQUIRE_FREEURL_AUTHENTICATION).toBe("true");
      }
    });
  });
});

describe("HedgeDoc stack configuration", () => {
  // These assert the resolved config, because that is where a dangerous value
  // would actually come from — the modules above only see what config supplies.
  const stackConfig = (stack: string) => read(`Pulumi.${stack}.yaml`);

  it("is enabled only on dev for now", () => {
    expect(stackConfig("dev")).toMatch(/hedgedocEnabled:\s*["']?true/);
    for (const stack of ["beta", "prod"]) {
      expect(stackConfig(stack)).not.toMatch(/hedgedocEnabled:\s*["']?true/);
    }
  });

  it("configures no egress address that would widen the firewall", () => {
    const dev = stackConfig("dev");
    const block = dev.split("hedgedocAllowedEgressIps:")[1] || "";
    const listed = block.split(/^\s{2}\S/m)[0];
    expect(listed).not.toMatch(/0\.0\.0\.0/);
    expect(listed).toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("keeps every credential as encrypted ciphertext", () => {
    const dev = stackConfig("dev");
    for (const key of [
      "hedgedocDbAdminPassword",
      "hedgedocDbAppPassword",
      "hedgedocSessionSecret",
      "hedgedocGoogleClientId",
      "hedgedocGoogleClientSecret",
    ]) {
      expect(dev).toMatch(new RegExp(`${key}:\\s*\\n\\s*secure:`));
    }
  });

  it("runs the vulnerability scan after the tests in CI", () => {
    // Ordering regression guard: when `yarn audit` ran first it exited non-zero
    // on pre-existing advisories and the unit tests never executed at all.
    const wf = read(".github/workflows/pr-checks.yml");
    // Match the `run:` lines, not prose in the surrounding comment.
    expect(wf.indexOf("run: yarn test:coverage")).toBeGreaterThan(-1);
    expect(wf.indexOf("run: yarn audit")).toBeGreaterThan(-1);
    expect(wf.indexOf("run: yarn test:coverage")).toBeLessThan(wf.indexOf("run: yarn audit"));
    // ...and audit must not gate the job, or the pre-existing advisories skip everything downstream.
    expect(wf).toMatch(/run: yarn audit[\s\S]{0,120}continue-on-error:\s*true/);
  });
});
