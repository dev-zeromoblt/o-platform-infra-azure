import * as fs from "fs";
import * as path from "path";

const rootDir = path.resolve(__dirname, "../..");
const deploymentsDir = path.join(rootDir, "deployments");

const read = (p: string) => fs.readFileSync(path.join(rootDir, p), "utf-8");

describe("HedgeDoc deployment (BALL-46)", () => {
  it("ships all three deployment modules", () => {
    for (const mod of ["hedgedoc.ts", "hedgedoc-database.ts", "hedgedoc-ingress.ts"]) {
      expect(fs.existsSync(path.join(deploymentsDir, mod))).toBe(true);
    }
  });

  describe("single-instance constraint", () => {
    // HedgeDoc 1.x keeps realtime note state in process memory. Running more than
    // one replica against the same database corrupts notes:
    // https://docs.hedgedoc.org/faq/ — this is the invariant most likely to be
    // "optimised" away by someone adding an HPA later.
    const hedgedoc = read("deployments/hedgedoc.ts");

    it("pins the deployment to exactly one replica", () => {
      expect(hedgedoc).toMatch(/replicas:\s*1\b/);
    });

    it("never scales beyond one replica", () => {
      expect(hedgedoc).not.toMatch(/replicas:\s*(?!1\b)\d+/);
      expect(hedgedoc).not.toMatch(/HorizontalPodAutoscaler/);
    });

    it("uses Recreate so a rollout never runs two pods at once", () => {
      expect(hedgedoc).toMatch(/type:\s*"Recreate"/);
      expect(hedgedoc).not.toMatch(/RollingUpdate/);
    });

    it("documents why, so the constraint survives a refactor", () => {
      expect(hedgedoc).toMatch(/docs\.hedgedoc\.org\/faq/);
    });
  });

  describe("cluster policy compliance", () => {
    const hedgedoc = read("deployments/hedgedoc.ts");

    it("sets resource requests (k8sazurev1containerrequests denies pods without them)", () => {
      expect(hedgedoc).toMatch(/requests:\s*\{[\s\S]*?cpu:/);
      expect(hedgedoc).toMatch(/requests:\s*\{[\s\S]*?memory:/);
    });

    it("declares readiness and liveness probes", () => {
      expect(hedgedoc).toMatch(/readinessProbe:/);
      expect(hedgedoc).toMatch(/livenessProbe:/);
    });

    it("gives migrations room via a startup probe", () => {
      expect(hedgedoc).toMatch(/startupProbe:/);
    });

    it("runs unprivileged as the image's non-root uid", () => {
      expect(hedgedoc).toMatch(/runAsNonRoot:\s*true/);
      expect(hedgedoc).toMatch(/allowPrivilegeEscalation:\s*false/);
      // fsGroup is what lets the non-root user write the uploads PVC.
      expect(hedgedoc).toMatch(/fsGroup:\s*HEDGEDOC_UID/);
    });
  });

  describe("database", () => {
    const db = read("deployments/hedgedoc-database.ts");

    it("admits only explicitly allowed egress addresses", () => {
      // A private endpoint is impossible here: AKS Automatic applies a deny
      // assignment to its node resource group that blocks subnets/join for every
      // principal. The public endpoint is instead narrowed to the cluster's NAT
      // gateway IP, so an empty allow-list must be treated as a bug.
      expect(db).toMatch(/FirewallRule/);
      expect(db).toMatch(/allowedEgressIps\.length === 0/);
      expect(db).not.toMatch(/0\.0\.0\.0/);
    });

    it("enforces TLS in transit rather than relying on the Azure default", () => {
      expect(db).toMatch(/require_secure_transport/);
      expect(db).toMatch(/value:\s*"on"/);
    });

    it("explains why a private endpoint was not used", () => {
      expect(db).toMatch(/deny assignment/i);
    });

    it("pins the API version that supports private link", () => {
      // The provider default (2022-12-01) has neither network.publicNetworkAccess
      // nor storage.autoGrow.
      expect(db).toMatch(/dbforpostgresql\.v20240801\.Server/);
    });

    it("enables backups", () => {
      expect(db).toMatch(/backupRetentionDays/);
    });
  });

  describe("ingress", () => {
    const ingress = read("deployments/hedgedoc-ingress.ts");

    it("terminates TLS via cert-manager and forces https", () => {
      expect(ingress).toMatch(/cert-manager\.io\/cluster-issuer/);
      expect(ingress).toMatch(/force-ssl-redirect":\s*"true"/);
    });

    it("holds websockets open far longer than the nginx default", () => {
      // HedgeDoc's realtime editing keeps a socket.io connection open for the
      // whole editing session; 60s would drop collaborators mid-edit.
      const readTimeout = ingress.match(/proxy-read-timeout":\s*"(\d+)"/);
      expect(readTimeout).not.toBeNull();
      expect(Number(readTimeout![1])).toBeGreaterThanOrEqual(3600);
    });

    it("allows image uploads through the proxy", () => {
      expect(ingress).toMatch(/proxy-body-size/);
    });
  });

  describe("access control", () => {
    const hedgedoc = read("deployments/hedgedoc.ts");

    it("is closed to anonymous users and self-registration", () => {
      expect(hedgedoc).toMatch(/"CMD_ALLOW_ANONYMOUS",\s*value:\s*"false"/);
      expect(hedgedoc).toMatch(/"CMD_ALLOW_EMAIL_REGISTER",\s*value:\s*"false"/);
    });

    it("restricts Google sign-in to a single Workspace domain", () => {
      expect(hedgedoc).toMatch(/CMD_GOOGLE_HOSTEDDOMAIN/);
    });
  });

  describe("stack wiring", () => {
    const index = read("index.ts");

    it("is opt-in per stack", () => {
      expect(index).toMatch(/getBoolean\("hedgedocEnabled"\)/);
    });

    it("is enabled only on dev for now", () => {
      expect(read("Pulumi.dev.yaml")).toMatch(/hedgedocEnabled:\s*["']?true/);
      for (const stack of ["beta", "prod"]) {
        expect(read(`Pulumi.${stack}.yaml`)).not.toMatch(/hedgedocEnabled:\s*["']?true/);
      }
    });

    it("pins an explicit image tag rather than latest", () => {
      expect(index).toMatch(/quay\.io\/hedgedoc\/hedgedoc:\d+\.\d+\.\d+/);
      expect(index).not.toMatch(/hedgedoc:latest/);
    });

    it("exports the site url and database fqdn", () => {
      expect(index).toMatch(/export const hedgedocSiteUrl/);
      expect(index).toMatch(/export const hedgedocDatabaseFqdn/);
    });
  });
});
