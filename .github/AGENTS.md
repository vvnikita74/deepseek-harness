# AGENTS.md — GitHub Actions

This fork keeps one workflow, [deploy.yml](workflows/deploy.yml): a push to master deploys over SSH. All upstream CI, release, packaging and policy workflows were removed; checks run locally through `scripts/run-gates.ts` and the lefthook pre-commit hook.
