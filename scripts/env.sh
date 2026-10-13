#!/usr/bin/env bash
# Pause or resume the dev/beta Azure environment (AKS + everything running on it).
#
# pause : destroys the streaming, navigation and Redpanda stacks, then sets
#         paused=true on this stack so `pulumi up` deletes the AKS cluster
#         (control plane, VMSS nodes, NAT gateway, load balancer, PVC disks).
#         Kept: resource group, ACR, DNS zone (prod's NS delegation stays valid).
#         ALL DATA in Redpanda, Conduktor and navigation Postgres is lost.
# resume: recreates the cluster, updates the AWS OIDC trust, then redeploys
#         Redpanda, navigation and streaming.
#
# Every Pulumi step shows its preview and asks for confirmation.
#
# Usage:
#   scripts/env.sh pause  dev|beta
#   scripts/env.sh resume dev|beta [--aws-profile <profile>]
#
# Repos are expected as siblings of this one; override with ROOT=/path/to/repos.
set -euo pipefail

ACTION="${1:-}"
ENV="${2:-}"
shift 2 2>/dev/null || true
AWS_PROFILE_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --aws-profile) AWS_PROFILE_ARG="${2:?}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
case "$ACTION" in pause|resume) ;; *) usage ;; esac
case "$ENV" in dev|beta) ;; *) echo "environment must be dev or beta (never prod)" >&2; usage ;; esac

ROOT="${ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
AZURE="$ROOT/o-platform-infra-azure"
RPK="$ROOT/o-platform-infra-rpk"
NAV="$ROOT/OPlatformNavigationService/deployments"
STREAMING="$ROOT/OPlatformStreamingService/deployments"

# AWS side of the OIDC trust (see OPlatformInfraCDK lib/stacks/event-stack.ts)
case "$ENV" in
  dev)  AWS_STAGE=devo; AWS_REGION_FOR_ENV=us-east-1 ;;
  beta) AWS_STAGE=beta; AWS_REGION_FOR_ENV=ap-southeast-1 ;;
esac

for dir in "$AZURE" "$RPK" "$NAV" "$STREAMING"; do
  [ -f "$dir/Pulumi.yaml" ] || { echo "Pulumi project not found: $dir" >&2; exit 1; }
done

# Resume deploys whatever is checked out, so show it.
echo "environment: $ENV   action: $ACTION"
for dir in "$AZURE" "$RPK" "$NAV" "$STREAMING"; do
  branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD)"
  note=""; [ "$branch" = "main" ] || note="   <-- not main"
  printf '  %-60s %s%s\n' "$dir" "$branch" "$note"
done
echo

confirm() {
  local answer
  read -r -p "$1 Type '$ENV' to continue: " answer
  [ "$answer" = "$ENV" ] || { echo "aborted"; exit 1; }
}

up()      { echo; echo ">> pulumi up      $1 ($ENV)"; (cd "$1" && pulumi up --stack "$ENV"); }
destroy() { echo; echo ">> pulumi destroy $1 ($ENV)"; (cd "$1" && pulumi destroy --stack "$ENV"); }

if [ "$ACTION" = "pause" ]; then
  confirm "This deletes the $ENV AKS cluster and ALL its data (Redpanda topics, Conduktor, navigation DB)."

  # Apps first (they need the cluster to delete cleanly), consumers before Redpanda.
  destroy "$STREAMING"
  destroy "$NAV"
  destroy "$RPK"

  (cd "$AZURE" && pulumi config set paused true --stack "$ENV")
  up "$AZURE"

  echo
  echo "$ENV is paused. Remaining cost: ACR + DNS zone."
  echo "Commit $AZURE/Pulumi.$ENV.yaml (paused: \"true\") so CI does not recreate the cluster."
  exit 0
fi

# resume
confirm "This recreates the $ENV AKS cluster and redeploys Redpanda, navigation and streaming."

(cd "$AZURE" && pulumi config set paused false --stack "$ENV")
up "$AZURE"

# New cluster = new OIDC issuer; AWS stores it without https:// and trailing slash.
ISSUER="$(cd "$AZURE" && pulumi stack output oidcIssuerUrl --stack "$ENV")"
ISSUER="${ISSUER#https://}"; ISSUER="${ISSUER%/}"
PARAM="/$AWS_STAGE/redpanda/oidc-issuer-url"
echo
echo "new OIDC issuer: $ISSUER"
if [ -n "$AWS_PROFILE_ARG" ]; then
  aws ssm put-parameter --profile "$AWS_PROFILE_ARG" --region "$AWS_REGION_FOR_ENV" \
    --name "$PARAM" --type String --overwrite --value "$ISSUER" >/dev/null
  echo "updated SSM $PARAM"
else
  echo "update it in AWS:"
  echo "  aws ssm put-parameter --region $AWS_REGION_FOR_ENV --name $PARAM --type String --overwrite --value '$ISSUER'"
fi
echo
echo "Then redeploy the AWS EventStack so IAM trusts the new cluster:"
if [ "$ENV" = "dev" ]; then
  echo "  cd $ROOT/OPlatformInfraCDK && DEPLOYMENT_MODE=devo npx cdk deploy devo-EventStack --force"
else
  echo "  run 'Release change' on CodePipeline OBasePipeline (it stops at the Beta-Prod approval)"
fi
read -r -p "Press Enter once EventStack is redeployed (Redpanda Connect needs it to reach AWS IoT/SQS)... " _

IOT_DIR="$(cd "$RPK" && pulumi config get iotCertsDir --stack "$ENV" 2>/dev/null || true)"
if [ -n "$IOT_DIR" ] && [ ! -d "$IOT_DIR" ]; then
  echo "IoT certs dir $IOT_DIR is missing. Run $RPK/scripts/fetch-iot-certs.sh first, then re-run resume." >&2
  exit 1
fi

up "$RPK"        # Redpanda + topic/schema init job
up "$NAV"
up "$STREAMING"

echo
echo "$ENV is resumed."
echo "Commit $AZURE/Pulumi.$ENV.yaml (paused: \"false\") so CI keeps the cluster."
