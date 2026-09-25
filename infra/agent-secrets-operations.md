# Agent-secrets launchd contract

The [job definition](launchd/com.joel.agent-secrets.plist) uses `ProcessType=Interactive`. Credential RPCs serve interactive clients; background CPU/I/O throttling can leave the process alive but unable to answer within the client's deadline. This Unix-socket service has no XPC transactions to promote an Adaptive job.

The [service-account installer](install-agent-secrets-service-account.sh) sources [the removal guard](lib/launchd-wait-removed.sh). Both cutover and rollback wait for confirmed job removal before changing files or bootstrapping. `bootout` acknowledges a request before teardown finishes. The guard accepts only the observed absent-service response (exit 113 and `Could not find service`), bounds the wait, and fails closed on unrelated errors.

Do not rerun a store migration just to recover from a transient timeout. Use the supervised RPC restart when responsive, or the approved break-glass restart when it is not. A scheduling/configuration change requires a backed-up plist reload; kickstart alone keeps the loaded definition.

After a reload, check the loaded `spawn type`, a bounded sample of status RPCs, and an authorized lease whose value is discarded. Keep private incident evidence in the owning Brain, not this public repository.

Run the fixture regression checks without sudo or live service changes:

```sh
bash infra/agent-secrets-launchd.test.sh
```

They cover scheduling configuration, asynchronous removal, already-absent jobs, permission/error handling, and bounded teardown failure. They do not exercise a privileged service-account migration.

For the generic diagnostic and reload procedure, see [agent-secrets daemon operations](https://github.com/joelhooks/agent-secrets/blob/main/docs/daemon-operations.md).
