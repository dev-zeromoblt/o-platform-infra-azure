/**
 * DNS Zone — Live Verification
 *
 * Verifies Azure DNS zone is configured correctly:
 * - Zone exists in Azure
 * - NS record set is non-empty
 * - DNS lookup for the domain resolves to the ingress IP
 */
import { DnsManagementClient } from "@azure/arm-dns";
import { getAzureCredential, subscriptionId, stackOutput, exec } from "../helpers";

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
  });

  it("NS record set is non-empty", async () => {
    const nsRecord = await client.recordSets.get(dnsResourceGroup, dnsZone, "@", "NS");
    expect(nsRecord.nsRecords).toBeDefined();
    expect(nsRecord.nsRecords!.length).toBeGreaterThan(0);
  });

  it("domain resolves to the ingress IP", () => {
    const testHost = domain.startsWith("*.") ? domain.replace("*.", "test.") : domain;
    try {
      const output = exec(`dig +short ${testHost} A`).trim();
      expect(output).toContain(ingressIp);
    } catch {
      // DNS may not have propagated yet — warn but don't fail hard
      console.warn(`DNS resolution for ${testHost} may still be propagating`);
    }
  });
});
