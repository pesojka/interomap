# Autosave collector

`server.mjs` is a dependency-free Node HTTP receiver. Deploy this version before
the new frontend: it supports legacy final submissions as well as checkpoints.
No results are publicly readable. The existing origin, size, rate, and storage
limits apply to both endpoints. Each saved session counts once toward the quota.

## Storage and analysis

- `/data/drafts/<UUID>.json`: latest `in_progress` checkpoint per session.
- `/data/<UUID>.json`: immutable completed submission, including legacy records.
- New records carry server `status`, `receivedAt`, `submissionId`, `dataset`, and
  a hash of the session write token. Drafts also carry their latest `revision`.
- Final saving promotes a session to a completed record and removes its draft.
  A later checkpoint cannot recreate that draft or change the completed result.
- Recursive authenticated exports of `/data` include drafts. Treat them separately
  in analysis. Never publish the result directory, kubeconfig, or write tokens.
- `dataset.progress` records baseline completion and numbers of completed maps and
  ratings. `completed: false` means a map was unvisited, while `completed: true`
  with `responded: false` is a completed empty map. `resumes` records repeated
  starts after refresh. Practice drawings are never collected.
- Existing pre-autosave results remain unchanged and may lack these new fields.

## Contract

`POST /checkpoints` accepts JSON with `submissionId` (UUID v4), `writeToken`
(independent random UUID v4), positive integer `revision`, and `dataset` containing
`status: "in_progress"`, accepted consent, and the normal experiment data.
A new draft returns 201; replacement or retry returns 200. Successful receipts
contain `saved: true`, matching `submissionId`, and the stored `revision`.
Lower revisions never overwrite newer revisions; conflicting data at the same
revision returns 409. Only the session's write token can update its draft.

`POST /submissions` uses the same session UUID and write token and a frozen final
`dataset` with `status: "complete"`. Successful receipts contain `saved: true`
and matching `submissionId`. Repeating an identical completed submission returns
200; conflicting data cannot overwrite it. Legacy submissions without a token
remain accepted when no draft exists for that UUID.

Files are written to a temporary file and synced before atomic publication.
Updates and completion are serialized per session. On restart, a completed
record wins over any leftover draft from an interrupted promotion. Keep a single
collector replica; the lock and quota accounting are in-process.

## Client behavior

Checkpoints follow participant setup, practice, baseline, completed picture maps,
completed ratings, and section starts. One request runs at a time, coalescing
queued progress to the latest revision. Failures retry after 60 seconds, on the
next completed step, or when the browser comes online. Final upload retains the
existing automatic attempts, manual retry, and JSON/CSV backup controls.

Same-tab refresh resumes from session storage. An interrupted step restarts its
picture exposure and fresh map/rating. Closing the tab or changing devices does
not support recovery, although already acknowledged drafts remain on the server.
There is no public draft-reading endpoint. Storage failures are reported on the
instruction screens. The final acknowledgement clears local checkpoints.

## Validation

From the published repository root:

```sh
node --test tests/experiment-blocks.test.mjs collector/*.test.mjs
```

In the research workspace the frontend resides under `task/`; the local copy of
`experiment-upload.test.mjs` uses that path. Tests cover draft revision ordering,
ownership, racing updates/finalization, quotas, restart, immutable finals, legacy
uploads, refresh recovery, offline retry, unchanged randomization, and the full
consent/practice/16-map/16-rating sequence. Browser QA verifies local server
receipts and same-tab refresh/resume with synthetic participants.
