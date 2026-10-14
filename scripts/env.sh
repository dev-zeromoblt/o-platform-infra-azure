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
# All previews run first, then one confirmation, then every step runs unattended.
# Both actions are safe to re-run: if a step fails, fix the cause and run the
# same command again.
#
# Usage:
#   scripts/env.sh pause  dev|beta
#   scripts/env.sh resume dev|beta [--aws-profile <profile>]
#
# Repos are expected as siblings of this one; override with ROOT=/path/to/repos.
set -euo pipefail

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

[ $# -ge 2 ] || usage
ACTION="$1"
ENV="$2"
shift 2
AWS_PROFILE_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --aws-profile) AWS_PROFILE_ARG="${2:?--aws-profile needs a value}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

case "$ACTION" in pause|resume) ;; *) usage ;; esac
case "$ENV" in dev|beta) ;; *) echo "environment must be dev or beta (never prod)" >&2; usage ;; esac

ROOT="${ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
AZURE="$ROOT/o-platform-infra-azure"
RPK="$ROOT/o-platform-infra-rpk"
NAV="$ROOT/OPlatformNavigationService/deployments"
STREAMING="$ROOT/OPlatformStreamingService/deployments"
AZURE_CONFIG="$AZURE/Pulumi.$ENV.yaml"

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

# --- failure handling --------------------------------------------------------
# The paused config is changed before the cluster `pulumi up`. If anything fails
# before that up succeeds, put Pulumi.$ENV.yaml back so the checkout matches
# what is deployed. After it succeeds the new value is the truth and is kept.
STEP="starting"
CONFIG_BACKUP=""
CONFIG_PENDING=0
on_exit() {
  local status=$?
  if [ "$CONFIG_PENDING" = 1 ] && [ -n "$CONFIG_BACKUP" ]; then
    cp "$CONFIG_BACKUP" "$AZURE_CONFIG"
    echo "restored $AZURE_CONFIG (cluster paused state was not changed)" >&2
  fi
  if [ -n "$CONFIG_BACKUP" ]; then rm -f "$CONFIG_BACKUP"; fi
  if [ "$status" -ne 0 ] && [ "$STEP" != "declined" ]; then
    echo >&2
    echo "FAILED during: $STEP" >&2
    echo "Fix the cause, then re-run: scripts/env.sh $ACTION $ENV${AWS_PROFILE_ARG:+ --aws-profile $AWS_PROFILE_ARG}" >&2
    echo "Every step is safe to repeat (already-destroyed stacks and finished ups are no-ops)." >&2
  fi
}
trap on_exit EXIT

set_paused() {
  CONFIG_BACKUP="$(mktemp)"
  cp "$AZURE_CONFIG" "$CONFIG_BACKUP"
  CONFIG_PENDING=1
  (cd "$AZURE" && pulumi config set paused "$1" --stack "$ENV")
}

confirm() {
  local answer
  echo
  read -r -p "$1 Type '$ENV' to continue: " answer
  [ "$answer" = "$ENV" ] || { STEP="declined"; echo "aborted, nothing was changed"; exit 1; }
}

# ALLOW_PAUSE_CHANGE lets index.ts flip the paused state; a plain `pulumi up` refuses.
preview_azure() { STEP="preview $AZURE"; echo; echo ">> pulumi preview $AZURE ($ENV)"; (cd "$AZURE" && ALLOW_PAUSE_CHANGE=1 pulumi preview --stack "$ENV"); }
up_azure()      { STEP="pulumi up $AZURE"; echo; echo ">> pulumi up      $AZURE ($ENV)"; (cd "$AZURE" && ALLOW_PAUSE_CHANGE=1 pulumi up --yes --stack "$ENV"); CONFIG_PENDING=0; }
up()            { STEP="pulumi up $1"; echo; echo ">> pulumi up      $1 ($ENV)"; (cd "$1" && pulumi up --yes --stack "$ENV"); }
destroy()       { STEP="pulumi destroy $1"; echo; echo ">> pulumi destroy $1 ($ENV)"; (cd "$1" && pulumi destroy --yes --stack "$ENV"); }
preview_destroy() { STEP="preview destroy $1"; echo; echo ">> pulumi destroy --preview-only $1 ($ENV)"; (cd "$1" && pulumi destroy --preview-only --stack "$ENV"); }

if [ "$ACTION" = "pause" ]; then
  # 1. Previews only. Nothing is changed until the confirmation below.
  preview_destroy "$STREAMING"
  preview_destroy "$NAV"
  preview_destroy "$RPK"
  set_paused true
  preview_azure

  confirm "The previews above delete the $ENV AKS cluster and ALL its data (Redpanda topics, Conduktor, navigation DB)."

  # 2. Apps first (they need the cluster to delete cleanly), consumers before Redpanda.
  destroy "$STREAMING"
  destroy "$NAV"
  destroy "$RPK"
  up_azure

  STEP="done"
  echo
  echo "$ENV is paused. Remaining cost: ACR + DNS zone."
  echo "Commit $AZURE_CONFIG (paused: \"true\") now: until it is on main, CI deploys of this stack fail on purpose."
  exit 0
fi

# resume
# 1. Checks and previews only. The app stacks cannot be previewed until the cluster exists.
STEP="checking IoT certs"
IOT_DIR="$(cd "$RPK" && pulumi config get iotCertsDir --stack "$ENV" 2>/dev/null || true)"
if [ -n "$IOT_DIR" ] && [ ! -d "$IOT_DIR" ]; then
  echo "IoT certs dir $IOT_DIR is missing. Run $RPK/scripts/fetch-iot-certs.sh first." >&2
  exit 1
fi
set_paused false
preview_azure

confirm "This recreates the $ENV AKS cluster and redeploys Redpanda, navigation and streaming."

# 2. Cluster
up_azure

# 3. New cluster = new OIDC issuer; AWS stores it without https:// and trailing slash.
STEP="reading oidcIssuerUrl"
ISSUER="$(cd "$AZURE" && pulumi stack output oidcIssuerUrl --stack "$ENV")"
ISSUER="${ISSUER#https://}"; ISSUER="${ISSUER%/}"
[ -n "$ISSUER" ] || { echo "oidcIssuerUrl is empty" >&2; exit 1; }
PARAM="/$AWS_STAGE/redpanda/oidc-issuer-url"
echo
echo "new OIDC issuer: $ISSUER"
ISSUER_CHANGED=1
if [ -n "$AWS_PROFILE_ARG" ]; then
  STEP="updating SSM $PARAM"
  CURRENT="$(aws ssm get-parameter --profile "$AWS_PROFILE_ARG" --region "$AWS_REGION_FOR_ENV" \
    --name "$PARAM" --query Parameter.Value --output text 2>/dev/null || true)"
  if [ "$CURRENT" = "$ISSUER" ]; then
    ISSUER_CHANGED=0
    echo "SSM $PARAM already up to date"
  else
    aws ssm put-parameter --profile "$AWS_PROFILE_ARG" --region "$AWS_REGION_FOR_ENV" \
      --name "$PARAM" --type String --overwrite --value "$ISSUER" >/dev/null
    echo "updated SSM $PARAM"
  fi
else
  echo "update it in AWS (skip if it already has this value):"
  echo "  aws ssm put-parameter --region $AWS_REGION_FOR_ENV --name $PARAM --type String --overwrite --value '$ISSUER'"
fi

if [ "$ISSUER_CHANGED" = 1 ]; then
  echo
  echo "Then redeploy the AWS EventStack so IAM trusts the new cluster:"
  if [ "$ENV" = "dev" ]; then
    echo "  cd $ROOT/OPlatformInfraCDK && DEPLOYMENT_MODE=devo npx cdk deploy devo-EventStack --force"
  else
    echo "  run 'Release change' on CodePipeline OBasePipeline (it stops at the Beta-Prod approval)"
  fi
  STEP="waiting for EventStack redeploy"
  read -r -p "Press Enter once EventStack is redeployed (Redpanda Connect needs it to reach AWS IoT/SQS)... " _
fi

# 4. Apps
up "$RPK"        # Redpanda + topic/schema init job
up "$NAV"
up "$STREAMING"

STEP="done"
echo
echo "$ENV is resumed."
echo "Commit $AZURE_CONFIG (paused: \"false\") now: until it is on main, CI deploys of this stack fail on purpose."
