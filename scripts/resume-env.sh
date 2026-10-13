#!/usr/bin/env bash
# Resume an environment paused by pause-env.sh: restores the saved replica
# counts, namespace by namespace in REVERSE pause order (so Redpanda, which was
# paused last, starts first), waiting for each workload to roll out before
# moving on.
#
# DRY RUN by default. Add --apply to really do it.
#
# Usage:
#   ./resume-env.sh --context dev [--apply] [--no-wait] [--timeout 10m]
set -euo pipefail

CONTEXT=""
APPLY=0
WAIT=1
TIMEOUT="10m"
STATE_FILE=""

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --context) CONTEXT="${2:?}"; shift 2 ;;
    --state-file) STATE_FILE="${2:?}"; shift 2 ;;
    --timeout) TIMEOUT="${2:?}"; shift 2 ;;
    --no-wait) WAIT=0; shift ;;
    --apply) APPLY=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$CONTEXT" ] || { echo "--context is required" >&2; usage; }
[ -n "$STATE_FILE" ] || STATE_FILE="./.env-pause-${CONTEXT}.state"
[ -f "$STATE_FILE" ] || { echo "no state file: $STATE_FILE (was this environment paused with pause-env.sh?)" >&2; exit 1; }

KC="kubectl --context $CONTEXT"

if ! kubectl config get-contexts -o name | grep -qx "$CONTEXT"; then
  echo "kubectl context '$CONTEXT' not found." >&2; exit 1
fi

# Namespaces in pause order (first appearance), then reversed.
PAUSE_ORDER="$(awk '!seen[$1]++ {print $1}' "$STATE_FILE")"
RESUME_ORDER="$(echo "$PAUSE_ORDER" | awk '{a[NR]=$0} END {for (i=NR;i>=1;i--) print a[i]}')"

echo "context : $CONTEXT"
echo "mode    : $([ "$APPLY" -eq 1 ] && echo APPLY || echo 'DRY RUN (add --apply)')"
echo "order   : $(echo $RESUME_ORDER)"
echo

for ns in $RESUME_ORDER; do
  echo "== namespace $ns"
  # StatefulSets before Deployments inside a namespace (databases/brokers first).
  for want in StatefulSet Deployment; do
    { grep -E "^$ns $want " "$STATE_FILE" || true; } | while read -r _ kind name replicas; do
      lower="$(echo "$kind" | tr '[:upper:]' '[:lower:]')"
      if [ "$replicas" = "0" ] || [ "$replicas" = "<none>" ]; then
        continue
      fi
      echo "  $lower/$name -> $replicas"
      if [ "$APPLY" -eq 1 ]; then
        $KC -n "$ns" scale "$lower/$name" --replicas="$replicas"
      fi
    done
  done

  if [ "$APPLY" -eq 1 ] && [ "$WAIT" -eq 1 ]; then
    for want in StatefulSet Deployment; do
      { grep -E "^$ns $want " "$STATE_FILE" || true; } | while read -r _ kind name replicas; do
        lower="$(echo "$kind" | tr '[:upper:]' '[:lower:]')"
        if [ "$replicas" = "0" ] || [ "$replicas" = "<none>" ]; then
          continue
        fi
        echo "  waiting for $lower/$name (timeout $TIMEOUT)"
        if ! $KC -n "$ns" rollout status "$lower/$name" --timeout="$TIMEOUT"; then
          echo "ERROR: $ns/$lower/$name not ready in $TIMEOUT. Stopping so later namespaces don't start against a broken dependency." >&2
          echo "Fix it, then re-run (already-restored workloads are skipped by kubectl as no-ops) or use --no-wait." >&2
          exit 1
        fi
      done
    done
  fi
done

if [ "$APPLY" -ne 1 ]; then
  echo
  echo "dry run: nothing changed. Re-run with --apply."
  exit 0
fi

mv "$STATE_FILE" "$STATE_FILE.restored-$(date +%Y%m%d-%H%M%S)"
echo
echo "done. State file archived next to the original."
