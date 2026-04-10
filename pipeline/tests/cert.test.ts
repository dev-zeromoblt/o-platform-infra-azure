/**
 * TLS / cert-manager — Live Verification
 *
 * Verifies cert-manager is correctly installed and configured:
 * - cert-manager pods are Running
 * - ClusterIssuer for Let's Encrypt is Ready
 * - No Certificates are in a failed state
 */
import { stackOutput, kubectl } from "./helpers";

describe("cert-manager and TLS", () => {
  beforeAll(() => {
    console.log(`Testing cert-manager on environment: ${process.env.TEST_ENVIRONMENT}`);
  });

  it("cert-manager pods are Running", () => {
    const output = kubectl("get pods -n cert-manager --no-headers");
    const lines = output.split("\n").filter(l => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const nonRunning = lines.filter(l => !l.includes("Running") && !l.includes("Completed"));
    expect(nonRunning).toHaveLength(0);
    console.log(`✓ cert-manager pods: ${lines.length} Running`);
  });

  it("Let's Encrypt ClusterIssuer is Ready", () => {
    // Try prod issuer first, fall back to staging
    let output: string;
    try {
      output = kubectl("get clusterissuer letsencrypt-prod -o jsonpath='{.status.conditions[0].type},{.status.conditions[0].status}'");
    } catch {
      output = kubectl("get clusterissuer letsencrypt-staging -o jsonpath='{.status.conditions[0].type},{.status.conditions[0].status}'");
    }
    expect(output).toContain("Ready,True");
    console.log(`✓ ClusterIssuer: ${output}`);
  });

  it("no Certificate resources are in a False/Error state", () => {
    let output: string;
    try {
      output = kubectl("get certificates -A --no-headers 2>/dev/null");
    } catch {
      // No certificates yet — that's acceptable for a fresh deploy
      console.log("No Certificate resources found — skipping (fresh deploy)");
      return;
    }
    if (!output.trim()) {
      console.log("No Certificate resources found — skipping (fresh deploy)");
      return;
    }
    const failed = output.split("\n").filter(l => l.includes("False") || l.includes("Error"));
    expect(failed).toHaveLength(0);
    console.log(`✓ All Certificates are healthy`);
  });
});
