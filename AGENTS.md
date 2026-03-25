# AGENTS RUNBOOK

This file is for future coding agents working on this repository.

## Production target

- Host: `77.223.98.97`
- User: `root`
- App path: `/opt/andrew_20off_bot`
- Runtime: Docker Compose profile `prod`

## Deployment workflow (GitHub Actions + GHCR)

Deploy trigger:

- push to `main` or `master`.
- workflow builds image, pushes to GHCR, then deploys to Selectel over SSH.

Required GitHub repository secrets:

- `SELECTEL_HOST`
- `SELECTEL_USER`
- `SELECTEL_SSH_KEY`
- `SELECTEL_PORT` (optional; defaults to `22`)
- `SELECTEL_APP_PATH` (for this project: `/opt/andrew_20off_bot`)
- `GHCR_USERNAME`
- `GHCR_TOKEN`

Manual fallback deploy (if Actions unavailable):

```bash
ssh root@77.223.98.97
cd /opt/andrew_20off_bot
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin
BOT_IMAGE=ghcr.io/<owner>/andrew_20off_bot:<tag-or-sha> docker compose --profile prod pull bot
BOT_IMAGE=ghcr.io/<owner>/andrew_20off_bot:<tag-or-sha> docker compose --profile prod up -d bot
```

## Operations cheatsheet (production)

```bash
ssh root@77.223.98.97 "cd /opt/andrew_20off_bot && docker compose logs -f bot"
ssh root@77.223.98.97 "cd /opt/andrew_20off_bot && docker compose restart bot"
ssh root@77.223.98.97 "cd /opt/andrew_20off_bot && docker compose down"
ssh root@77.223.98.97 "cd /opt/andrew_20off_bot && docker compose ps"
```

## Logging and incident triage

Application logs are JSON lines written to stdout/stderr.

Quick checks:

```bash
ssh root@77.223.98.97 "cd /opt/andrew_20off_bot && docker compose logs --tail=120 bot"
ssh root@77.223.98.97 "cd /opt/andrew_20off_bot && docker compose logs -f bot"
```

Search important events:

```bash
ssh root@77.223.98.97 "cd /opt/andrew_20off_bot && docker compose logs --tail=500 bot | rg 'boot|poll|digest|auth|telegram|fatal|error'"
```

If deploy fails:

1. Check latest `CD` workflow logs in GitHub Actions.
2. Verify GHCR login on server and image availability.
3. Run `docker compose ps` and inspect bot logs.
4. Re-run deploy step manually with explicit `BOT_IMAGE` tag.

## Server hardening state

- `ufw` enabled with `OpenSSH` allowed.
- `fail2ban` enabled (`sshd` jail).
- `unattended-upgrades` enabled.
- Swap file configured: `2G`.
