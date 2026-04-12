import { ClientSecretCredential } from "@azure/identity";
import { execSync } from "child_process";

export function getAzureCredential(): ClientSecretCredential {
  const clientId = process.env.AZURE_CLIENT_ID!;
  const clientSecret = process.env.AZURE_CLIENT_SECRET!;
  const tenantId = process.env.AZURE_TENANT_ID!;
  if (!clientId || !clientSecret || !tenantId) {
    throw new Error("AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID must be set");
  }
  return new ClientSecretCredential(tenantId, clientId, clientSecret);
}

export const subscriptionId = () => {
  const id = process.env.AZURE_SUBSCRIPTION_ID;
  if (!id) throw new Error("AZURE_SUBSCRIPTION_ID must be set");
  return id;
};

export const stackOutput = (key: string): string => {
  const val = process.env[`STACK_${key.toUpperCase()}`];
  if (!val) throw new Error(`Stack output STACK_${key.toUpperCase()} is not set`);
  return val;
};

export function kubectl(args: string): string {
  return execSync(`kubectl ${args}`, { encoding: "utf-8" });
}

export function tcpConnect(host: string, port: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const net = require("net");
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP connect to ${host}:${port} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
