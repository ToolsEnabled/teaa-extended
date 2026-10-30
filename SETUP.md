See README.md for the TEAA Extended 0.5.0-alpha.9 candidate and qualification instructions.

# Setup

TEAA Extended 0.5.0-alpha.9 writes per-user configuration and prepares pinned Fleet V5, ToolsEngine and Knowledge components. Setup does not start FRA, the bundled Hub gateway, an account service, a model, worker, or browser.

## Upgrade in the same prefix

After installing the next TEAA app beside an earlier version in the same prefix, run `teaa setup`. For a verified earlier TEAA app whose Fleet V5 component identity matches the new bundle, setup uses Fleet’s own rebind operation and keeps the existing Fleet state and FRA enrollment. It prints one line after a successful rebind. Other runtime or identity mismatches stop with a TEAA instruction and leave the state unchanged; do not run a Fleet command manually. Stop any Hub or client using the state before retrying. If alpha.7 started the Hub, `teaa hub stop` needs the same `XDG_RUNTIME_DIR` value used at Hub start. See `UPGRADE.md`.

## Private data path

Bundled Fleet stores an audit signing key only when every existing ancestor of the state directory passes Fleet's private-directory rule:

- The path is absolute and contains no symbolic link.
- Each existing ancestor is a directory owned by the current user or by root.
- An ancestor with a group or other write bit is accepted only when it is owned by root and the sticky bit is set, as with `/tmp`.
- Fleet itself also requires the state directory, after creation, to be mode `0700`, owned by the user, with no extra attributes. Key files must be mode `0600`.

TEAA runs the native ancestor/ACL check before it creates `fleetV5-state`. When the check fails, setup stops and leaves an unfinished directory unchanged. Use a private data path; TEAA does not weaken Fleet's state protection.

After the path check, bundled setup makes a local, temporary Fleet audit call using the operator-only `--admin` option for that child process. The saved ordinary MCP command does not retain that option. That `--admin` flag is passed only to this local audit process and is not saved in the ordinary MCP configuration. Setup counts a problem unless `audit.ok` is true. The setup line is `Fleet audit: signing key available (audit.ok true)` when the key is available. This does not persist admin authority or alter Fleet configuration.

`teaa doctor` and `teaa doctor --json` check Node.js, the operating system, the project folder, and that Fleet, ToolsEngine and Knowledge start and list tools. `healthy: true` means that startup scope. It does not mean `audit.ok`.

## Commands

```sh
teaa setup --folder /absolute/project --actor local --no-browser --workers
teaa doctor
teaa doctor --json
teaa config --server-json
teaa mcp --actor local
```

`--folder` is the ToolsEngine workspace and must be outside the TEAA install tree and outside Fleet state. `--actor local` is a Fleet ownership label. It is not a provider login. `--no-browser` keeps browser tools out of the ToolsEngine list. `--browser` selects an installed browser and does not download one. On Linux the trusted locations are `/opt/google/chrome/chrome`, `/opt/microsoft/msedge/msedge`, and `chromium` or `chromium-browser` on `PATH`. Setup does not change AppArmor, `/opt`, or the browser sandbox. ToolsEngine asks for that sandbox. Playwright's Chromium launch includes `--password-store=basic`. When none of those browsers is present, setup stops before it saves a browser change.

`--workers` is required when creating the Fleet V5 state used by ordinary TEAA setup. Omitting it retains the explicit workers-off behavior. Ordinary setup and doctor return `FLEET_V5_WORKERS_REQUIRED` when that state cannot provide the Fleet contract tools; the message directs you to preserve and move the workers-off `fleetV5-state` aside, then rerun `teaa setup --workers` with the intended project and options. Fleet fixes worker capability when state is created, so setup does not change an existing choice in place. `--workers` enables capability only: setup does not start a worker, model, provider, or agent CLI. Provider CLIs are needed only when a person later starts a worker. This build creates a distinct `fleetV5-state`; it does not read, convert, copy, or remove a prior `fleetV4-state`. A state transfer requires a separately authorized, explicit Fleet migration procedure.

Provider CLIs are used only when a person later starts a Fleet worker. Setup does not spawn one.

On Windows, run the archive's `install.cmd`; it calls the Node installer directly and does not depend on PowerShell script execution policy. Optional flags are `install.cmd --prefix "C:\Tools\TEAA"` and `install.cmd --prefix "C:\Tools\TEAA" --uninstall`. The installer supports `--prefix`, `--uninstall`, and `--add-to-path`; no user or machine PATH change occurs unless the last option is explicitly selected.

## What the first run creates

Under the TEAA data directory:

- `fleetV5-state` for this bundled Fleet V5.
- `knowledge-config.json` only when that file is absent: repository path, `sync` `off`, `interior` `refuse`. No `origin` field.
- `knowledge-repo` only when that directory is absent: one git commit, slug `sample`, no git remote. If the directory exists without `.git`, setup stops and leaves it unchanged.

## Knowledge origin

`knowledge_project_update` commits and pushes. With no origin it returns `ORIGIN_MISSING` and the message `project_update requires origin`. The brief revision stays as it was. That refusal is the default. Setup does not invent a GitHub, GitLab, or other network remote, and it does not turn `sync` on.

`--local-knowledge-origin` is the explicit local option:

```sh
teaa setup --local-knowledge-origin
```

It creates `<data-dir>/knowledge-origin.git` as a bare repository beside the sample, adds that filesystem path as the sample's `origin`, and pushes the current branch. `sync` stays `off`. The command does not contact a network host. `knowledge-config.json` is not given an `origin` URL. Knowledge reads the git remote.

The flag refuses, and leaves the repository and config unchanged, when any of these is true:

- `knowledge-config.json` points at a repository other than the sample this setup created
- the config already has an `origin` field
- the sample already has a different `origin`
- `sync` is not `off`
- the sample has uncommitted changes
- `<data-dir>/knowledge-origin.git` already exists and is not this sample's origin

Running it again, when that same bare repository is already the origin, changes nothing. A customer who wants a different remote adds it with git. A local bare repository is not cloud sync. Background sync stays off until the customer sets `sync` in `knowledge-config.json`.

Configuration is `$XDG_CONFIG_HOME/toolsenabled-agent-kit/config.json`, or `~/.config/toolsenabled-agent-kit/config.json`.

## Isolated example

```sh
teaa_demo_dir=$(mktemp -d /tmp/teaa-demo-XXXXXX)
mkdir -p "$teaa_demo_dir/project" "$teaa_demo_dir/bin" "$teaa_demo_dir/config" "$teaa_demo_dir/data"
chmod 700 "$teaa_demo_dir" "$teaa_demo_dir/project" "$teaa_demo_dir/bin" "$teaa_demo_dir/config" "$teaa_demo_dir/data"
env XDG_CONFIG_HOME="$teaa_demo_dir/config" XDG_DATA_HOME="$teaa_demo_dir/data" \
  TEAA_BIN="$teaa_demo_dir/bin" TEAA_PREFIX="$teaa_demo_dir/data/teaa" \
  teaa setup --folder "$teaa_demo_dir/project" --actor local --no-browser --workers
```

Use the same command-local environment values for later commands against this isolated example. Unset `TEAA_KNOWLEDGE`, `TEAA_FLEET_HOST` and `TEAA_TOOLSENGINE` so setup uses the bundled copies.

## Host entry

Register the JSON from `teaa config --server-json` as one stdio server. Keep any separate Fleet, ToolsEngine or Knowledge entries only when you intend to run those programs twice. Restart the host and call `teaa_status`.

## TEAA Extended commands

The Extended edition adds FRA device enrollment and the bundled Fleet Hub client/host commands. Use `teaa open --account https://ACCOUNT-ORIGIN --name NAME`, explicitly complete the account service's normal approval, then `teaa accept --account https://ACCOUNT-ORIGIN --expect-email EMAIL_SHOWN_BY_RESERVATION`. A self-hosted account origin must use HTTPS; WSS rendezvous is derived on the same hostname at `/v1/rendezvous`. `teaa status` only reports local enrollment. Configure one explicit FRA Hub profile and select it with `teaa select-hub FILE`; use `teaa select-local` to restore the saved local Fleet entry. Run `teaa hub start|status|stop` for the bundled native Linux or Windows Hub gateway. These commands do not install a service or change host MCP configuration. `install.cmd --uninstall` or `install.ps1 -Uninstall` on Windows, or `./install.sh --uninstall` on Linux, removes only the owned application and command; configuration, FRA enrollment and Fleet state remain. See EXTENDED-SETUP.md.
