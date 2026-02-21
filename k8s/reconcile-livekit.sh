#!/usr/bin/env bash
set -euo pipefail

NS="${1:-joelclaw}"
VALUES_FILE="$(cd "$(dirname "$0")" && pwd)/livekit-values.yaml"

helm upgrade --install livekit-server livekit/livekit-server \
  -n "$NS" \
  -f "$VALUES_FILE"

# Chart lacks probe host/timing knobs. Keep these overrides idempotent.
kubectl patch deployment livekit-server -n "$NS" --type='strategic' -p '{
  "spec":{
    "template":{
      "spec":{
        "containers":[{
          "name":"livekit-server",
          "startupProbe":{
            "httpGet":{"host":"127.0.0.1","path":"/","port":"http","scheme":"HTTP"},
            "periodSeconds":5,
            "timeoutSeconds":1,
            "failureThreshold":24,
            "successThreshold":1
          },
          "livenessProbe":{
            "httpGet":{"host":"127.0.0.1","path":"/","port":"http","scheme":"HTTP"},
            "initialDelaySeconds":30,
            "periodSeconds":10,
            "timeoutSeconds":1,
            "failureThreshold":6,
            "successThreshold":1
          },
          "readinessProbe":{
            "httpGet":{"host":"127.0.0.1","path":"/","port":"http","scheme":"HTTP"},
            "initialDelaySeconds":10,
            "periodSeconds":5,
            "timeoutSeconds":1,
            "failureThreshold":6,
            "successThreshold":1
          }
        }]
      }
    }
  }
}'

kubectl patch svc livekit-server -n "$NS" --type='json' -p='[
  {"op":"replace","path":"/spec/type","value":"NodePort"},
  {"op":"replace","path":"/spec/ports/0/nodePort","value":7880},
  {"op":"replace","path":"/spec/ports/1/nodePort","value":7881}
]'

kubectl rollout status deployment/livekit-server -n "$NS" --timeout=180s
