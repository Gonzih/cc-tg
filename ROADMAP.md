## cc-agent: Self-Driving Scheduler Roadmap

### Phase 1: Dependent job scheduling
- `depends_on: string[]` field on SpawnOptions
- Jobs with unmet dependencies stay in `pending` status
- Internal scheduler loop (setInterval, 5s) checks pending jobs, promotes to running when dependencies are done
- If dependency failed → dependent job fails with reason

### Phase 2: create_plan tool
- `create_plan({ goal, steps: [{id, task, repo, depends_on}] })`
- Returns plan_id
- Steps execute in dependency order via Phase 1 scheduler
- `list_plans` / `get_plan` tools

### Phase 3: Cron-aware job completion
- Cron prompt template supports `{{list_jobs}}` placeholder — injected at runtime
- Cron sessions can react to job completions without hardcoding logic
