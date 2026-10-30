# Native Windows host candidate

Fleet 1.10.0-rc.1 adds a native Windows x64 host distribution. It runs Node.js and separately installed provider CLIs directly on Windows. WSL is not required. The standard MCP runtime retains workers, tasks, memory, ledgers and inherited permissions. Vendor plugin distributions keep their own fixed ceilings.

The installer requires Node.js 22.19 or newer, Windows PowerShell 5.1 and local NTFS. Verify the published archive digest before running its installer. Extract outside your installation and project folders, then run:

```
install.cmd --workspace "C:\Users\YOU\Projects\project" --enable-workers
```

Setup prints the exact `mcpServers` entry for your client and the installed check/uninstall commands. It does not edit provider configuration or read provider credentials. Keep using the provider's official sign-in. An MCP client should run the printed entry directly so Fleet can observe its parent process. Unobservable ancestry uses the conservative fallback; roles and explicit caps can only narrow it.

Standalone unrestricted file mediation can cover permitted projects on other local drives and shared directories. The startup project remains the base for relative paths. Confined sessions and vendor plugins retain their project limits. Known credential and executable control paths remain protected; native file/shell edits do not join mediation. All participating sessions must use the same Fleet state root for shared receipts and locks.

State uses a protected account/SYSTEM/Administrators DACL. Links, hard links, broadened private-file ACLs and unsupported volumes are refused. Worker process trees use Windows Job Objects and creation-time identities. A random session token authenticates the local named pipe; stopped or replaced sessions lose access. These are ownership and cooperative-agent controls, not protection from another program with the same account privileges.

Close Fleet clients before uninstalling. Uninstall checks the installed file hashes and refuses changed runtime files or active servers. It removes that version only; state and workspace are retained. Remove the MCP entry from your client when you retire the installation. Keep older versions until the new one is checked.

Release qualification must include the extracted archive's installed runtime: worker-enabled stdio, private-state refusal, observed parent inheritance, contained worker start/approval denial/stop/resume, invalid and stale token refusal, fresh installation/check/uninstall, and the Job Object lifecycle tests. Protocol fixtures do not establish a vendor subscription entitlement or real model compatibility. Record real CLI versions separately and do not claim vendor approval from these checks.

Build from a clean committed source with `python3 installer/host/build-windows.py OUTPUT`. Packaging is deterministic and does not bundle Node, Python, provider CLIs or credentials. Run the native qualification before publishing the Windows archive.
