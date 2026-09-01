# t3codectl

Small Node.js/TypeScript management CLI for a T3 Code installation.

## Commands

```text
t3codectl setup
t3codectl status
t3codectl pair
t3codectl update
t3codectl uninstall --yes
```

## Fresh-server setup

The host must run Linux with systemd and have Node.js 22 or newer, npm,
sqlite3, git, and `gh` available. The server also needs DNS configured for its
reachable hostname and an open firewall port for T3 Code (3773 by default).

The repository is private, so authenticate `gh` as the account that will run
the service, then clone and install the CLI globally. The package's `prepare`
script builds the TypeScript entrypoint automatically:

```bash
sudo -i
apt-get update
apt-get install -y sqlite3 git gh

# Install Node.js 22+ using the host's supported method, if it is not present.
node --version
npm --version
sqlite3 --version

gh auth login
gh repo clone spadaval/t3codectl /root/t3codectl
npm install --global /root/t3codectl
```

Configure the host directly through the installed command. Use a concrete
DNS name or IP address for `--host`; do not use `0.0.0.0`.

```bash
t3codectl setup --host t3.example.com --port 3773 --package nightly
```

`setup` asks T3 Code to install its own background service, so no separate T3
service-installation step is required. It may create the T3 Code home, then
adds the updater service, nightly timer, and persistent service drop-in.

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

`setup` asks T3 Code to install or repair its own `t3code.service`, then writes a small
systemd drop-in at `~/.config/systemd/user/t3code.service.d/10-t3codectl.conf`
for the configured host, port, mode, and PATH. It also installs an update
oneshot service and a nightly systemd timer. The timer invokes the same
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

## Development

```bash
npm install
npm test
npm run build
```

The production entrypoint is the compiled `dist/main.js`, installed as an
executable at `/usr/local/bin/t3codectl` by `t3codectl setup`.
