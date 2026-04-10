/**
 * TLS / cert-manager — Live Verification
 *
 * Verifies cert-manager is correctly installed and configured:
 * - cert-manager pods are Running
 * - ClusterIssuer for Let's Encrypt is Ready
 * - No Certificates are in a failed state
 */
import { kubectl } from "../helpers";

describe("cert-manager and TLS", () => {
  it("cert-manager pods are Running", () => {
    const output = kubectl("get pods -n cert-manager --no-headers");
    const lines = output.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const nonRunning = lines.filter((l) => !l.includes("Running") && !l.includes("Completed"));
    expect(nonRunning).toHaveLength(0);
  });

  it("Let's Encrypt ClusterIssuer is Ready", () => {
    let output: string;
    try {
      output = kubectl(
        "get clusterissuer letsencrypt-prod -o jsonpath='{.status.conditions[0].type},{.status.conditions[0].status}'"
      );
    } catch {
      output = kubectl(
        "get clusterissuer letsencrypt-staging -o jsonpath='{.status.conditions[0].type},{.status.conditions[0].status}'"
      );
    }
    expect(output).toContain("Ready,True");
  });

  it("no Certificate resources are in a False/Error state", () => {
    let output: string;
    try {
      output = kubectl("get certificates -A --no-headers 2>/dev/null");
    } catch {
      // No certificates yet — acceptable for a fresh deploy
      return;
    }
    if (!output.trim()) return;
    const failed = output.split("\n").filter((l) => l.includes("False") || l.includes("Error"));
    expect(failed).toHaveLength(0);
  });
});
