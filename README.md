# t3codectl

Small TypeScript/Bun management CLI for a T3 Code installation.

## Commands

```text
t3codectl setup
t3codectl status
t3codectl pair
t3codectl update
t3codectl uninstall --yes
```

## Fresh-server setup

The host must run Linux with systemd and have Node.js 22 or newer, npm, and
npx available for T3 Code. The server also needs DNS configured for
its reachable hostname and an open firewall port for T3 Code (3773 by
default). Bun is not required on the server.

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
mkdir -p /tmp/t3codectl
gh release download \
  --repo spadaval/t3codectl \
  --pattern 't3codectl-linux-x64' \
  --dir /tmp/t3codectl
install -m 0755 \
  /tmp/t3codectl/t3codectl-linux-x64 \
  /usr/local/bin/t3codectl
```

Configure the host directly through the installed command. Use a concrete
DNS name or IP address for `--host`; do not use `0.0.0.0`.

```bash
t3codectl setup
```

With a terminal, `setup` presents a guided configuration flow for the T3 Code
home, reachable hostname or IP, port, release channel, and update schedule.
It shows a summary and asks for confirmation before making changes. Existing
configuration values are used as the prompt defaults. Setup preserves comments
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

`setup` asks T3 Code to install its own background service, so no separate T3
service-installation step is required. It may create the T3 Code home, then
adds the updater service, hourly timer, and persistent service drop-in.
Before changing anything, setup verifies Node.js 22+, npm, and npx, plus
the required system tools (`systemctl`, `loginctl`, `flock`, and `ss`). It does
not install host runtimes or system packages automatically.

Verify the installation and generate a pairing URL:

```bash
t3codectl status
t3codectl pair
```

Run an update manually at any time with:

```bash
t3codectl update
```

For a stable release channel, use `--package latest` instead of
`--package nightly` during setup.

The default configuration is `/etc/t3codectl/config.env`.

## How it works

`setup` asks T3 Code to install or repair its own `t3code.service`, then writes a small
systemd drop-in at `~/.config/systemd/user/t3code.service.d/10-t3codectl.conf`
for the configured host, port, mode, and PATH. It also installs an update
oneshot service and an hourly systemd timer. The timer invokes the same
`t3codectl update` command used by an operator.

T3 Code owns `t3code.service` and may rewrite that unit during native service
updates. The drop-in remains in place, so those updates do not discard the
deployment settings managed here.

After a successful update, the active runtime and the two newest previous
runtime versions are retained. The configured npm cache is then cleaned to
prevent unattended updates from consuming the host disk.

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
tag is pushed. To create a release:

```bash
git tag v0.2.0
git push origin v0.2.0
```
