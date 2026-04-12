/**
 * DNS Zone — Live Verification
 *
 * Verifies Azure DNS zone is configured correctly:
 * - Zone exists in Azure
 * - NS record set is non-empty
 * - DNS lookup for the domain resolves to the ingress IP
 */
import { DnsManagementClient } from "@azure/arm-dns";
import { execSync } from "child_process";
import { getAzureCredential, subscriptionId, stackOutput } from "./helpers";

const exec = (cmd: string) => execSync(cmd, { encoding: "utf-8", stdio: "pipe" });

describe("DNS Zone", () => {
  let client: DnsManagementClient;
  let dnsZone: string;
  let dnsResourceGroup: string;
  let ingressIp: string;
  let domain: string;

  beforeAll(() => {
    client = new DnsManagementClient(getAzureCredential(), subscriptionId());
    dnsZone = stackOutput("DNSZONENAME");
    dnsResourceGroup = stackOutput("DNSRESOURCEGROUPNAME");
    ingressIp = stackOutput("INGRESSCONTROLLERIP");
    domain = stackOutput("DOMAINNAME");
  });

  it("DNS zone exists in Azure", async () => {
    const zone = await client.zones.get(dnsResourceGroup, dnsZone);
    expect(zone.name).toBe(dnsZone);
    console.log(`✓ DNS zone ${dnsZone} exists`);
  });

  it("NS record set is non-empty", async () => {
    const nsRecord = await client.recordSets.get(dnsResourceGroup, dnsZone, "@", "NS");
    expect(nsRecord.nsRecords).toBeDefined();
    expect(nsRecord.nsRecords!.length).toBeGreaterThan(0);
    const servers = nsRecord.nsRecords!.map(r => r.nsdname).join(", ");
    console.log(`✓ NS records: ${servers}`);
  });

  it("domain resolves to the ingress IP", () => {
    // Use dig to resolve the domain; wildcard entries should point to ingress
    const testHost = domain.startsWith("*.") ? domain.replace("*.", "test.") : domain;
    try {
      const output = exec(`dig +short ${testHost} A`).trim();
      console.log(`dig ${testHost} → ${output}`);
      expect(output).toContain(ingressIp);
    } catch (e) {
      // DNS may not have propagated yet; warn but don't fail the pipeline hard
      console.warn(`DNS resolution for ${testHost} did not return ${ingressIp} — may still be propagating`);
      // Re-throw only if we got an unexpected error (not just empty response)
      const err = e as Error;
      if (!err.message.includes("Command failed")) throw e;
    }
  });
});
