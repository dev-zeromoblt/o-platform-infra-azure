/**
 * Ingress Controller — Live Verification
 *
 * Verifies the ingress controller is reachable and serving traffic:
 * - Ingress controller pod(s) are Running in the cluster
 * - TCP connect to ingressControllerIP:80 succeeds
 * - TCP connect to ingressControllerIP:443 succeeds
 * - HTTP GET returns any response (proves traffic reaches ingress)
 */
import { stackOutput, kubectl, tcpConnect } from "./helpers";
import * as http from "http";

describe("Ingress Controller", () => {
  let ingressIp: string;

  beforeAll(() => {
    ingressIp = stackOutput("INGRESSCONTROLLERIP");
    console.log(`Testing ingress at: ${ingressIp}`);
  });

  it("ingress controller pods are Running", () => {
    const output = kubectl(
      "get pods -n ingress-nginx --no-headers 2>/dev/null || " +
      "kubectl get pods -A --no-headers -l app.kubernetes.io/name=ingress-nginx"
    );
    const runningPods = output.split("\n").filter(line => line.includes("Running")).length;
    expect(runningPods).toBeGreaterThan(0);
    console.log(`✓ Running ingress pods: ${runningPods}`);
  });

  it("TCP connect to port 80 succeeds within 5s", async () => {
    await expect(tcpConnect(ingressIp, 80, 5000)).resolves.toBeUndefined();
    console.log(`✓ TCP connect to ${ingressIp}:80 succeeded`);
  });

  it("TCP connect to port 443 succeeds within 5s", async () => {
    await expect(tcpConnect(ingressIp, 443, 5000)).resolves.toBeUndefined();
    console.log(`✓ TCP connect to ${ingressIp}:443 succeeded`);
  });

  it("HTTP GET to port 80 returns any response", async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`http://${ingressIp}/`, { timeout: 5000 }, (res) => {
        // Any HTTP response (even 404/200) proves ingress is alive
        console.log(`✓ HTTP GET ${ingressIp}:80 → HTTP ${res.statusCode}`);
        resolve();
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`HTTP GET to ${ingressIp}:80 timed out`));
      });
    });
  });
});
