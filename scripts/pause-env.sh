#!/usr/bin/env bash
# Pause an environment by scaling every Deployment/StatefulSet in the given
# namespaces to 0. Saves the current replica counts so resume-env.sh can
# restore them exactly.
#
# DRY RUN by default: prints what it would do. Add --apply to really do it.
#
# Usage:
#   ./pause-env.sh --context dev --ns "<streaming-ns> redpanda-connect-publisher-dev redpanda" [--apply]
#
# Namespace ORDER matters: list consumers first and Redpanda LAST.
# Nodes are only released by Karpenter once pods are gone; the control plane,
# system pool, disks and ACR keep billing.
set -euo pipefail

CONTEXT=""
NAMESPACES=""
APPLY=0
FORCE=0
STATE_FILE=""

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --context) CONTEXT="${2:?}"; shift 2 ;;
    --ns) NAMESPACES="${2:?}"; shift 2 ;;
    --state-file) STATE_FILE="${2:?}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$CONTEXT" ] || { echo "--context is required" >&2; usage; }
[ -n "$NAMESPACES" ] || { echo "--ns is required (space separated, consumers first, redpanda last)" >&2; usage; }
[ -n "$STATE_FILE" ] || STATE_FILE="./.env-pause-${CONTEXT}.state"

KC="kubectl --context $CONTEXT"

if ! kubectl config get-contexts -o name | grep -qx "$CONTEXT"; then
  echo "kubectl context '$CONTEXT' not found. Available:" >&2
  kubectl config get-contexts -o name >&2
  exit 1
fi

# Never touch cluster/system namespaces.
for ns in $NAMESPACES; do
  case "$ns" in
    kube-*|default|gatekeeper-system|app-routing-system|cert-manager|keda|aks-command)
      echo "refusing to scale system namespace: $ns" >&2; exit 1 ;;
  esac
  $KC get ns "$ns" >/dev/null 2>&1 || { echo "namespace not found: $ns" >&2; exit 1; }
done

# Running pause twice would overwrite the saved counts with zeros.
if [ -f "$STATE_FILE" ] && [ "$FORCE" -ne 1 ]; then
  echo "state file already exists: $STATE_FILE" >&2
  echo "environment looks already paused. Run resume-env.sh first, or pass --force to overwrite (you will lose the saved replica counts)." >&2
  exit 1
fi

echo "context : $CONTEXT"
echo "mode    : $([ "$APPLY" -eq 1 ] && echo APPLY || echo 'DRY RUN (add --apply)')"
echo "order   : $NAMESPACES"
echo

TMP_STATE="$(mktemp)"
trap 'rm -f "$TMP_STATE"' EXIT

for ns in $NAMESPACES; do
  # KEDA / HPA would fight a manual scale.
  if $KC -n "$ns" get scaledobject --no-headers 2>/dev/null | grep -q .; then
    echo "WARNING: namespace $ns has KEDA ScaledObjects; KEDA owns those replicas and may scale them back." >&2
  fi
  $KC -n "$ns" get deploy,sts \
      -o custom-columns=KIND:.kind,NAME:.metadata.name,REPLICAS:.spec.replicas --no-headers 2>/dev/null \
    | while read -r kind name replicas; do
        [ -n "$name" ] || continue
        echo "$ns $kind $name $replicas" >> "$TMP_STATE"
      done
done

if [ ! -s "$TMP_STATE" ]; then
  echo "no Deployments/StatefulSets found in: $NAMESPACES"; exit 0
fi

echo "workloads found (namespace kind name replicas):"
sed 's/^/  /' "$TMP_STATE"
echo

if [ "$APPLY" -ne 1 ]; then
  echo "dry run: nothing changed. Re-run with --apply to save $STATE_FILE and scale to 0."
  exit 0
fi

cp "$TMP_STATE" "$STATE_FILE"
echo "saved replica counts to $STATE_FILE"

while read -r ns kind name replicas; do
  lower="$(echo "$kind" | tr '[:upper:]' '[:lower:]')"
  if [ "$replicas" = "0" ] || [ "$replicas" = "<none>" ]; then
    continue
  fi
  echo "scaling $ns/$lower/$name  $replicas -> 0"
  $KC -n "$ns" scale "$lower/$name" --replicas=0
done < "$STATE_FILE"

echo
echo "done. Pods are terminating; Karpenter removes empty nodes after a short delay."
echo "To bring it back: ./resume-env.sh --context $CONTEXT --apply"
