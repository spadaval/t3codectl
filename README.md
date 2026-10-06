# t3codectl

Small TypeScript/Bun management CLI for a T3 Code installation.

## Commands

```text
t3codectl setup
t3codectl repair
t3codectl status
t3codectl pair
t3codectl update
t3codectl self-update
t3codectl uninstall --yes
```

## Fresh-server setup

The host must run Linux with systemd and have Node.js 22 or newer, npm, and
npx available for T3 Code. The server also needs DNS configured for
its reachable hostname and an open firewall port for T3 Code (3773 by
default). Outbound HTTPS access to the npm registry, GitHub, and GitHub release
assets is required to discover and download updates. Bun is not required on
the server.

Authenticate `gh` as the account that will run the service, then download the
latest standalone CLI release:

```bash
sudo -i
apt-get update
apt-get install -y gh

# Install Node.js 22+ using the host's supported method if needed.
node --version
npm --version
npx --version

gh auth login
gh release download \
  --repo spadaval/t3codectl \
  --pattern 't3codectl-linux-x64' \
  --output /usr/local/bin/t3codectl \
  --clobber
chmod 0755 /usr/local/bin/t3codectl
```

Configure the host directly through the installed command. Use a concrete
DNS name or IP address for `--host`; do not use `0.0.0.0`.

```bash
t3codectl setup
```

With a terminal, `setup` presents a guided configuration flow for the T3 Code
home, reachable hostname or IP, port, release channel, and update schedule.
It shows a summary and asks for confirmation before making changes. Existing
configuration values are used as the prompt defaults. Running instances are
reconfigured without invoking the native installer. Updater-only changes take
effect immediately, including a changed timer schedule. Server changes are
saved and restarted only when T3 is idle; a busy or unreadable instance keeps
running until a later update sweep can apply them. Pending changes retain the
old connection settings so recovery can still reach the running server.
Setup preserves comments
and unknown/custom variables in the existing configuration file, and accepting
the existing values does not restart T3 Code unnecessarily.

For automation or a session without a terminal, provide the required values
and disable prompts explicitly:

```bash
t3codectl setup \
  --non-interactive \
  --host t3.example.com \
  --port 3773 \
  --package nightly \
  --schedule hourly
```

`setup` installs T3 Code's native background service when it is missing, so no
separate service-installation step is required. Existing services are reused. It may create the T3 Code home, then
adds the updater service, hourly timer, and persistent service drop-in.
Before changing anything, setup verifies Node.js 22+, npm, and npx, plus
the required system tools (`systemctl`, `loginctl`, `flock`, `ss`, and `gh`). It does
not install host runtimes or system packages automatically.

Verify the installation and generate a pairing URL:

```bash
t3codectl status
t3codectl pair
```

If T3 Code is installed but stopped or unhealthy, reconcile the existing
installation and restart it without changing its configuration:

```bash
t3codectl repair
```

If setup or repair reports that the configured port is occupied by an older
T3 Code process, it prints the owning PID, command, cgroup, and recent service
logs. In an interactive terminal it offers to stop the identified T3 Code
process and retry. For an explicit non-interactive recovery, use:

```bash
t3codectl repair --stop-conflicting
```

Processes belonging to other applications are never stopped automatically;
the diagnostics show what owns the port so it can be handled separately.

Run an update manually at any time with:

```bash
t3codectl update
```

The same command runs on the configured timer (hourly by default). It completes
the T3 Code update attempt, scans for provider capacity failures, then checks the latest stable `t3codectl` GitHub release and installs
a newer CLI automatically. The updated CLI is used on the next run. The GitHub
account configured with `gh auth login` must retain access to this private
repository. If the CLI release check fails, the T3 Code result is preserved
and the CLI check retries on the next timer run.
Run `t3codectl self-update` to update only the CLI.
Hosts running an older CLI need this release installed once using the download
steps above; subsequent CLI releases are installed by the timer.

The update report has a **T3 Code** section (version change, idle check,
install, health), a **Maintenance** section (overload recovery and the CLI
release check), and ends with a one-line result such as
`✓ Updated T3 Code to …` or `! Update postponed. T3 Code is still on …`.
In a terminal, T3's own installer output collapses into a single progress line
and is printed in full only if it fails. Under systemd, the journal keeps the
complete installer output.

Each sweep uses a short-lived local auth credential to read T3's orchestration
API across projects. It resumes at most one eligible thread by sending a
continuation message in the existing thread, keeping its provider, model,
permissions, workspace, and conversation. Scanning does not call a model.
Recovery also runs when the version is current, the update is deferred, or the
update check fails. An unavailable server or unsupported protocol reports a
recovery error without changing T3 data directly.

Only explicit provider capacity/overload errors are retried. Quota, rate-limit,
billing, authentication, and unrelated failures are left for the user. Archived,
settled, snoozed, cancelled, busy, approval-waiting, and delegated subagent threads
are excluded. The first retry waits at least five minutes; further automatic
attempts wait 1, 2, 4, then 8 hours, with a maximum of five retries per failure
chain. Manual continuation starts a new chain. Durable command IDs prevent
uncertain delivery from creating duplicate runs after a timeout or process crash.
State is stored at `/var/lib/t3codectl/recovery-state.json`.

The sweep rechecks thread state immediately before sending. T3's protocol does
not offer an atomic capacity-failure continuation guard, so a simultaneous manual
send can still race the final check and queue the recovery message. Recovery
never steers or interrupts an active turn.

For a stable release channel, use `--package latest` instead of
`--package nightly` during setup.

The default configuration is `/etc/t3codectl/config.env`.

## How it works

`setup` reuses an installed `t3code.service`, or asks T3 Code to install it when missing, then writes a small
systemd drop-in at `~/.config/systemd/user/t3code.service.d/10-t3codectl.conf`
for the configured host, port, mode, and PATH. It also installs an update
oneshot service and an hourly systemd timer. The timer invokes the same
`t3codectl update` command used by an operator. Setup waits for T3 Code to
pass its health checks before reporting success.

`status` groups service health, version state, and automatic-update details in
a compact terminal view. It highlights healthy and current states in green,
problems such as version drift in red, and shows update times relatively (for
example, `2 hours ago`). Use `status --json` for exact timestamps and structured
details. Attempt state is recorded atomically at
`/var/lib/t3codectl/update-state.json`; attempts made before this tracking was
installed are identified as such.

CLI self-updates download the Linux x64 asset to a temporary directory beside
`/usr/local/bin/t3codectl`, verify its size and GitHub SHA-256 digest, run its
`--version` check, then atomically replace the executable. A failed check
leaves the installed binary in place. `t3codectl --version` reports the
installed CLI version.

`repair` reconciles configuration and reinstalls the existing native service at
its current version,
then restarts T3 Code when idle and waits for it to become healthy. A busy
instance retains its pending restart until a later sweep. If startup fails,
the command reports the health-check reason, port listeners, process details,
and recent `t3code.service` logs. `repair --stop-conflicting` explicitly stops
only listeners identified as T3 Code processes outside the configured service,
then retries once.

T3 Code owns `t3code.service` and may rewrite that unit during native service
updates. The drop-in remains in place, so those updates do not discard the
deployment settings managed here.

After a successful update, the active runtime and the two newest previous
runtime versions are retained. The configured npm cache is then cleaned to
prevent unattended updates from consuming the host disk.

On installations with T3's V2 database, the updater checks the authenticated
orchestration snapshot before restarting the service. Running, queued, preparing,
waiting, and background work defer the update; unreadable or unknown states block
it. Legacy installations retain the read-only database idle check.

Updates use T3 Code's native `t3 update` command with an exact version and
automatic service restart approval. The updater enables Node's environment
proxy support so `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` are honored; an
explicit `NODE_USE_ENV_PROXY` setting remains authoritative. If downloading an
update fails before the active runtime changes, `t3codectl` reports the command
failure and leaves the healthy existing runtime alone. If the active runtime
did change but fails verification, the newly downloaded CLI performs rollback
with explicit permission to return to the previous version. Health checks read
the stable active-version and update-status fields across T3 service-launcher
protocol revisions.

`uninstall` removes only the exact management executable, configuration file,
updater units, and the t3codectl drop-in. It does not stop, disable, or remove
`t3code.service`, and never deletes the T3 Code home, database, runtime state,
installed versions, or user data.

`pair` asks the running T3 Code server to mint a one-time pairing credential
and prints the complete pairing URL. Use `--base-url` when the reachable
address differs from the configured server address.

## Development and releases

```bash
bun install
npm test
```

`npm test` builds and exercises the standalone Linux x64 release binary at
`dist/t3codectl-linux-x64`. GitHub Actions publishes that binary when a `v*`
tag matching `package.json` is pushed. Bump the package version before tagging.
For example:

```bash
git tag v0.2.3
git push origin v0.2.3
```
