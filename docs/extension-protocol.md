# Extension import protocol and upgrades

The browser extension and server can be updated at different times. Their import protocol is versioned separately from the application's release number so an unsupported pairing can stop safely while keeping pending observations in the browser.

This is the protocol compatibility foundation of V1-17. It does not complete database, export, backup, or future checkpoint migrations. Only import protocol **1** is implemented.

## Discovery and request contract

An import-only bearer token is required for `GET /api/extension/status`. In addition to `ok`, the application `version`, and the library's `instance_id`, a current server returns:

```json
{
  "extension_protocol": {
    "name": "little-archive.extension",
    "versions": {
      "1": {
        "capabilities": [
          "current_view_imports",
          "idempotent_batches",
          "exact_batch_finish",
          "source_collection_memberships",
          "partial_coverage"
        ],
        "limits": {
          "max_batch_items": 50,
          "max_batch_bytes": 262144
        }
      }
    }
  }
}
```

The extension selects version 1 only when the name, version, every required capability, and sufficient limits are present. Additional version entries or capability names do not prevent selection of version 1. A larger advertised limit does not make this extension send larger batches. A smaller limit is incompatible: existing queued batches must not be split or given new identities automatically.

| Capability | Version 1 meaning |
| --- | --- |
| `current_view_imports` | An import run binds one explicitly supplied source account, platform and scope. It does not enumerate every account collection. |
| `idempotent_batches` | The server commits a batch atomically; an identical run/batch ID/sequence/payload replay returns the recorded result. Changed content under a used identity conflicts. |
| `exact_batch_finish` | Finishing requires exactly the committed sequence set `0` through `expected_batches - 1`. |
| `source_collection_memberships` | Observations can retain stable source collection keys and exact supplied names, including overlapping memberships. |
| `partial_coverage` | A run can record partial or observed enumeration-exhausted coverage. A zero-batch run remains partial. Missing observations do not delete records. |

Pairing, starting, resuming, each queued batch upload, and completion perform a fresh status check. The library instance must still match the checkpoint. For negotiated version 1, each import POST includes `X-Little-Archive-Protocol: 1`. Discovery GET requests do not need this header. The header does not appear in the JSON payload or its idempotency digest.

The server accepts exactly one explicit header value `1`. Unknown, empty, combined or duplicate values receive HTTP 409 before any import run, batch, or item mutation. Normal authentication still applies; the token's ordinary last-used timestamp may be updated. Errors explain that compatible releases are required and pending batches should be kept.

The new header is added to the existing narrow extension CORS allow-list. This adds no extension permission, network destination, credentialed CORS access, source-platform request, or owner API privilege.

## Compatibility matrix

| Extension and server | Result |
| --- | --- |
| Current extension + server explicitly advertising compatible protocol 1 | Negotiated mode; version header sent on import writes. |
| Current extension + original status with `version: "0.1.0"` and **no** `extension_protocol` property | Known legacy mode; visible popup notice and historical headerless import writes. |
| Original extension + current server | Historical headerless version 1 writes remain accepted. Existing response fields are retained. |
| Current extension + another release without protocol metadata | Stop with server-update guidance; preserve pending observations. |
| Current extension + malformed, null or unsupported explicit metadata | Stop; do not reinterpret it as the original legacy server. |
| Current extension + protocol 1 missing a required capability or offering smaller limits | Stop; do not rewrite or split pending batches. |
| Current extension + a different library instance | Stop; reconnect the original library to deliver the bound scan. |
| Current extension + an unsupported browser storage format or run protocol | Keep the checkpoint; install a compatible extension before resuming. |

The legacy rule supports the one known preceding contract. It does not prove an arbitrary server that reports the same application version implements that contract. Users should update the server to obtain explicit capability discovery. The popup labels legacy mode and identifies a successful negotiated check as the **last** server check, not a guarantee of continuing availability.

## Durable checkpoints and recovery

Version 1 uses the existing batch JSON unchanged. New runs store `protocolVersion: 1` alongside the run's identity in local extension state. Existing version 1 storage whose run has no `protocolVersion` field is recognized as the original protocol without adding fields to or reconstructing its queued bodies.

Compatibility errors block affected uploads and stop an active scanner. The error remains visible in the popup. A finishing run keeps its completion pending until compatibility returns. The run ID, batch ID, sequence, observation body, source collection labels, account binding, and server instance binding survive. Retry bookkeeping such as attempt count, next-attempt time and blocked status may change. The extension never generates replacement identities to work around a compatibility failure.

After compatible software is restored, **Retry uploads** sends the original batches. If the server committed a batch but its response was lost, its idempotency record makes the identical retry safe. **Resume** also requires the original account and source view; it does not switch a scan to a different library or token.

Keep the existing browser profile during recovery. **Forget this scan**, disconnecting, uninstalling the extension, or clearing its browser storage can intentionally remove pending local observations. Those are not upgrade or recovery steps. A future storage format this extension does not understand is rejected even by its normal reset commands, so a downgraded extension cannot erase an unknown checkpoint accidentally.

For this unpacked distribution, also preserve the **same registered extension identity and folder**. Pause capture, replace the runtime files in the folder Chrome already loads, then click **Reload** on that same entry in `chrome://extensions`. Reopen the popup and retry/resume after inspecting its retained checkpoint. Do not remove the extension or load a newly extracted directory as a second extension while work is pending. Keeping the browser profile alone does not transfer one extension identity's local storage to another. Chrome's [manifest key documentation](https://developer.chrome.com/docs/extensions/reference/manifest/key) explains consistent identities, and its [unpacked-directory reference](https://developer.chrome.com/docs/extensions/mv2/architecture-overview#referring-to-files) describes directory-dependent IDs. This candidate does not introduce a manifest key; adding one retroactively would require its own identity/storage migration plan.

All historical server import runs use the same version 1 body semantics; this change adds no database column or import-record migration. A future incompatible protocol must include a deliberate durable-run and checkpoint migration design before it is advertised. It must not silently reinterpret existing run IDs or pending bodies as the new version.

## Verification

Fast regressions cover negotiation, the narrow original-status fallback, malformed metadata, missing capabilities, reduced limits, unknown checkpoint formats, unchanged queued bodies and explicit-version HTTP headers. Real temporary FastAPI tests cover advertised capabilities, headerless-to-versioned replay, preserved idempotency conflicts, exact completion sequences, rejected unsupported writes, and restricted CORS behavior.

The packaged-extension suite adds two compatibility cases: a visible legacy declaration with real headerless imports, and an incompatible declaration while a real committed batch remains unacknowledged in the browser. Only status metadata is deliberately rewritten by that test relay; all import mutations and replay responses come from the real server. These fixtures do not run an older server binary or establish live Instagram/TikTok compatibility. The separate existing browser-restart case checks durable storage recovery.

Run the focused checks from the repository root:

```sh
node --test extension/tests/*.test.mjs
python -m unittest tests.test_extension_protocol -v
```

Run the packaged extension tests using the isolated server harness and headed Chromium under Xvfb, as documented in [the extension integration suite](../extension/tests/e2e/README.md). Test discovery alone is not an executed browser result. Release evidence must identify the exact candidate and completed CI run.
