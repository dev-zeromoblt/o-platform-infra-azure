# HedgeDoc

Self-hosted [HedgeDoc](https://hedgedoc.org) — internal collaborative markdown notes
for ZeroMoblt staff. Tracked as [BALL-46](https://zeromoblt.youtrack.cloud/issue/BALL-46).

| | dev |
|---|---|
| URL | https://docs.dev.az.zeromoblt.com |
| Namespace | `hedgedoc-dev` |
| Image | `quay.io/hedgedoc/hedgedoc:1.11.1` |
| Database | `psql-hedgedoc-dev.postgres.database.azure.com` |
| Resource group | `dev-hedgedoc-rg` |

## Why a single replica

HedgeDoc 1.x holds realtime note state in process memory. The upstream FAQ is
explicit that running more than one instance against one database "will result in
missing/broken content for users".

**Do not add replicas and do not add an HPA.** Scale vertically
(`hedgedocCpuLimit` / `hedgedocMemoryLimit`) instead. The Deployment uses the
`Recreate` strategy so a rollout never briefly runs two pods. HedgeDoc boots in a
few seconds, so a restart is a short blip rather than a data risk.

At ~40-50 users a single `500m`-`2` CPU / `768Mi`-`2Gi` pod is comfortable.

## Architecture

```
Internet
   |
   v
AKS managed NGINX (webapprouting.kubernetes.azure.com)   <- cert-manager letsencrypt-prod
   |  docs.dev.az.zeromoblt.com
   v
Service hedgedoc:80 -> Pod hedgedoc:3000  (1 replica, Recreate)
   |                        |
   |                        +-- PVC hedgedoc-uploads (20Gi managed-csi) -> /hedgedoc/public/uploads
   |                        +-- ConfigMap hedgedoc-config -> /files/config.json (Postgres TLS opts)
   |                        +-- Secret hedgedoc-secrets (CMD_DB_URL, session secret, Google OAuth)
   v
Managed NAT gateway (104.211.98.71) -- the cluster's only egress address
   |
   v
Azure Postgres Flexible Server 16, firewalled to that one IP, TLS enforced
```

### Networking — why this is not a private endpoint

A private endpoint in the AKS node subnet was the intended design and **is not
possible on an AKS Automatic cluster**. AKS owns the VNet inside the `MC_*` node
resource group and applies a *deny assignment* to it, which blocks
`Microsoft.Network/virtualNetworks/subnets/join/action` and
`virtualNetworks/join/action` for every principal. Deny assignments cannot be
overridden by granting RBAC roles, so this fails even as subscription owner:

```
Status=403 Code="LinkedAuthorizationFailed" ... is blocked by deny assignments
on the '1' linked scope(s) '.../aks-vnet-.../subnets/aks-subnet'
```

That also rules out peering a VNet of our own to the AKS VNet (same deny on
`peer`/`join`), and VNet integration needs a delegated subnet at server-creation
time, which we cannot create there either.

What we do instead:

- the server keeps a public endpoint (`publicNetworkAccess: "Enabled"`),
- a single firewall rule admits only the cluster's egress address,
- `require_secure_transport` is pinned to `on`, and the client verifies the
  server certificate.

The cluster's `outboundType` is `managedNATGateway`, so that egress address is
stable for the cluster's lifetime rather than a rotating load-balancer IP. It is
supplied via the `hedgedocAllowedEgressIps` config:

```bash
az network public-ip list \
  -g $(az aks show -g dev-aks-rg -n aks-dev1050f8e6 --query nodeResourceGroup -o tsv) \
  --query "[].ipAddress" -o tsv
```

Pick the NAT gateway IP, **not** the ingress load-balancer IP (`4.213.214.62`).
Verify from inside the cluster if unsure:

```bash
kubectl --context aks-dev1050f8e6 run egresscheck --rm -i --restart=Never \
  --image=curlimages/curl:8.10.1 -- curl -s https://api.ipify.org
```

If the cluster is ever rebuilt with a bring-your-own VNet, switch this back to a
private endpoint — the deny assignment only covers the AKS-managed VNet.

### Postgres TLS

Azure enforces TLS. HedgeDoc builds Sequelize as `new Sequelize(dbURL, dbConfig)`,
and Sequelize does not reliably map connection-string query parameters onto the
`pg` driver — so `?sslmode=require` on `CMD_DB_URL` is not dependable. TLS options
are instead supplied through the mounted `config.json`:

```json
{ "production": { "db": { "dialect": "postgres",
  "dialectOptions": { "ssl": { "require": true, "rejectUnauthorized": true } } } } }
```

Certificate verification stays on: Azure Postgres certs chain to DigiCert Global
Root G2, which Node trusts.

### Ingress

`proxy-read-timeout` / `proxy-send-timeout` are raised to 3600s. HedgeDoc's
realtime editing holds a socket.io websocket open for as long as a note is being
edited; the 60s nginx default would drop collaborators mid-session.
`proxy-body-size` is 50m for image uploads.

## Configuration

Everything is gated behind `hedgedocEnabled`, so enabling it on `dev` does not
implicitly change `beta`/`prod`.

| Key | Default | Notes |
|---|---|---|
| `hedgedocEnabled` | `false` | Master switch for the stack |
| `hedgedocDomain` | — | Must be a subdomain of the stack `domain` |
| `hedgedocAllowedEgressIps` | — | List; the cluster's NAT gateway IP(s). Empty is rejected |
| `hedgedocImage` | `quay.io/hedgedoc/hedgedoc:1.11.1` | Never use `:latest` |
| `hedgedocDbAdminUser` | `hedgedocadmin` | |
| `hedgedocDbAdminPassword` | — | **secret**, keep URL-safe (alphanumeric) |
| `hedgedocDbName` | `hedgedoc` | |
| `hedgedocPgVersion` | `16` | |
| `hedgedocPgSku` / `hedgedocPgTier` | `Standard_B2s` / `Burstable` | Use `GP_Standard_D2s_v3` / `GeneralPurpose` for prod |
| `hedgedocPgStorageGB` | `32` | auto-grow enabled |
| `hedgedocPgBackupDays` | `14` | |
| `hedgedocPgHighAvailability` | `false` | Zone-redundant HA; enable for prod |
| `hedgedocSessionSecret` | — | **secret** |
| `hedgedocGoogleClientId` / `ClientSecret` | — | **secret**, optional |
| `hedgedocGoogleHostedDomain` | `zeromoblt.com` | Restricts SSO to the Workspace domain |
| `hedgedocUploadsSize` / `hedgedocUploadsStorageClass` | `20Gi` / `managed-csi` | |
| `hedgedocCpuRequest`/`Limit`, `hedgedocMemoryRequest`/`Limit` | `500m`/`2`, `768Mi`/`2Gi` | |

> The DB password ends up inside `CMD_DB_URL`. Keep it alphanumeric so it needs no
> percent-encoding.

### Authentication

Google Workspace OAuth only. Email self-registration (`CMD_ALLOW_EMAIL_REGISTER`)
and anonymous access (`CMD_ALLOW_ANONYMOUS`) are both off, and
`CMD_GOOGLE_HOSTEDDOMAIN` restricts sign-in to the Workspace domain.

The Google OAuth client needs this redirect URI:

```
https://docs.dev.az.zeromoblt.com/auth/google/callback
```

If the Google credentials are unset, HedgeDoc still boots and migrates the
database but offers no way to sign in.

## Deploying

> **Read this before running `pulumi up` on the `dev` stack.**
>
> The `dev` stack state contains 8 Redis Enterprise resources (`dev-mobility-redis`
> and its VNet / private endpoint) whose code is **not** in `index.ts` on `main`.
> An untargeted `pulumi up` on `dev` will **delete the dev Redis cache**. Until
> that drift is resolved, deploy HedgeDoc with `--target`.

```bash
pulumi preview --stack dev   # confirm: no unexpected deletes

pulumi up --stack dev \
  --target 'urn:pulumi:dev::o-platform-infra-azure::azure-native:resources:ResourceGroup::hedgedoc-rg-dev' \
  --target 'urn:pulumi:dev::o-platform-infra-azure::azure-native:dbforpostgresql/v20240801:Server::hedgedoc-pg-dev' \
  --target 'urn:pulumi:dev::o-platform-infra-azure::azure-native:dbforpostgresql/v20240801:Database::hedgedoc-db-dev' \
  --target 'urn:pulumi:dev::o-platform-infra-azure::azure-native:dbforpostgresql/v20240801:Configuration::hedgedoc-pg-require-tls-dev' \
  --target 'urn:pulumi:dev::o-platform-infra-azure::azure-native:dbforpostgresql/v20240801:FirewallRule::hedgedoc-pg-fw-dev-0' \
  --target 'urn:pulumi:dev::o-platform-infra-azure::azure-native:network:RecordSet::hedgedoc-dns-dev' \
  --target 'urn:pulumi:dev::o-platform-infra-azure::kubernetes:core/v1:Namespace::hedgedoc-ns-dev' \
  --target 'urn:pulumi:dev::o-platform-infra-azure::kubernetes:core/v1:ConfigMap::hedgedoc-config-dev' \
  --target 'urn:pulumi:dev::o-platform-infra-azure::kubernetes:core/v1:PersistentVolumeClaim::hedgedoc-uploads-dev' \
  --target 'urn:pulumi:dev::o-platform-infra-azure::kubernetes:core/v1:Secret::hedgedoc-secret-dev' \
  --target 'urn:pulumi:dev::o-platform-infra-azure::kubernetes:core/v1:Service::hedgedoc-svc-dev' \
  --target 'urn:pulumi:dev::o-platform-infra-azure::kubernetes:apps/v1:Deployment::hedgedoc-deploy-dev' \
  --target 'urn:pulumi:dev::o-platform-infra-azure::kubernetes:networking.k8s.io/v1:Ingress::hedgedoc-ingress-dev'
```

### kubelogin note

Pulumi builds its kubeconfig from `listClusterUserCredentials`, which hardcodes
`--login devicecode`. Locally that blocks on an interactive prompt and the preview
fails with "configured Kubernetes cluster is unreachable". Shim `kubelogin` on
`PATH` to rewrite the login method rather than editing the provider's kubeconfig —
changing the provider input risks replacing the existing cluster-wide k8s
resources (cert-manager and friends):

```bash
#!/usr/bin/env bash
newargs=()
for a in "$@"; do [[ "$a" == "devicecode" ]] && a="azurecli"; newargs+=("$a"); done
exec /usr/local/bin/kubelogin "${newargs[@]}"
```

## Operations

```bash
K="kubectl --context aks-dev1050f8e6 -n hedgedoc-dev"

$K get pods,svc,ingress,pvc
$K logs deploy/hedgedoc -f
$K rollout restart deploy/hedgedoc

# TLS certificate status
$K get certificate,certificaterequest
$K describe certificate hedgedoc-tls-dev

# Health endpoint from inside the cluster
$K exec deploy/hedgedoc -- node -e \
  "fetch('http://localhost:3000/_health').then(r=>r.json()).then(console.log)"
```

### Reaching the database

The firewall admits only the cluster's egress IP, so a laptop cannot connect even
with the password. Use a throwaway pod on the cluster:

```bash
kubectl --context aks-dev1050f8e6 -n hedgedoc-dev run psql --rm -it --restart=Never \
  --image=postgres:16-alpine \
  --env="PGPASSWORD=$(pulumi config get hedgedocDbAdminPassword --stack dev)" \
  -- psql -h psql-hedgedoc-dev.postgres.database.azure.com -U hedgedocadmin -d hedgedoc
```

### Backups

Azure Flexible Server takes automatic backups with 14-day point-in-time restore.
Restore creates a *new* server:

```bash
az postgres flexible-server restore \
  --resource-group dev-hedgedoc-rg \
  --name psql-hedgedoc-dev-restored \
  --source-server psql-hedgedoc-dev \
  --restore-time "2026-08-03T10:00:00Z"
```

Uploaded images live on the `hedgedoc-uploads` PVC and are **not** covered by the
database backup. Snapshot the managed disk if uploads matter.

## Promoting to beta / prod

1. Create a Google OAuth client for the target hostname's callback URL.
2. Set the stack config (`hedgedocEnabled`, `hedgedocDomain`, `hedgedocAksVnetName`
   for that cluster, plus the secrets).
3. For prod, move off Burstable and turn on HA:
   ```
   hedgedocPgSku=GP_Standard_D2s_v3
   hedgedocPgTier=GeneralPurpose
   hedgedocPgHighAvailability=true
   hedgedocPgBackupDays=35
   ```
4. Keep `replicas: 1`. This does not change per environment — see the top of this
   document.
