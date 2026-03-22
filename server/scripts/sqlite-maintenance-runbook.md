# SQLite Maintenance and Cutover Runbook

This runbook is for post-migration SQLite operations (`data/yejingram.db`) and rollback-safe cutover checks.

## 1) Pre-cutover checks (before enabling `SERVER_STORAGE_BACKEND=sqlite`)

1. Stop or drain write traffic (maintenance mode).
2. Backup current legacy data directory.
3. Run migration and verification:

```bash
bun run migrate:json-to-sqlite --mode=skip-existing
bun run verify:sqlite-migration
```

4. Confirm verification exits with code `0` and no mismatches.

## 2) Post-cutover monitoring guidance

Monitor these at minimum during first 24h:

- Sync endpoint conflict/error rates (`409`, `410`, `5xx`).
- LLM queue pending backlog and completion latency.
- Push delivery success/error rate.
- SQLite file growth (`yejingram.db`, `yejingram.db-wal`).

If WAL file continuously grows or free pages accumulate, run maintenance during low traffic.

## 3) SQLite maintenance commands

### Checkpoint only (default mode: `TRUNCATE`)

```bash
bun run sqlite:maintenance
```

### Checkpoint + VACUUM + ANALYZE

```bash
bun run sqlite:maintenance --checkpoint-mode=TRUNCATE --vacuum --analyze
```

### Custom DB path

```bash
bun run sqlite:maintenance --sqlite-path=/absolute/path/to/yejingram.db --checkpoint-mode=FULL
```

The maintenance script prints:

- checkpoint result (`busy`, WAL frames, checkpointed frames)
- DB/WAL size before and after
- `page_count` and `freelist_count`

## 4) Rollback notes

- Immediate rollback: restart with `SERVER_STORAGE_BACKEND=file`.
- If sqlite-only writes happened after cutover, export before rollback:

```bash
bun run export:sqlite-to-json --output-data-dir=/tmp/yejingram-rollback-data
```

- Verify exported data against sqlite before switching back:

```bash
bun run verify:sqlite-migration --data-dir=/tmp/yejingram-rollback-data --sqlite-path=/absolute/path/to/yejingram.db
```

- Complete rollback by starting file backend against the exported data directory (or first restore that exported data into your live file-backend `DATA_DIR`, then start file backend there):

```bash
SERVER_STORAGE_BACKEND=file DATA_DIR=/tmp/yejingram-rollback-data bun server/index.ts
```

- Rollback is not complete until file backend is running on the exported/restored rollback dataset.
