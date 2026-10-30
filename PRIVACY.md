# TEAA Extended privacy and data handling

TEAA Extended installs executable source and component data. It does not bundle provider credentials, provider conversations, FRA account credentials, enrolled device identity, operational state, or a hosted gateway service.

Setup and ordinary Fleet operation write configuration and state under the current user's platform data directories. Knowledge synchronization defaults off; enabling it can access the explicitly selected local repository and any remote configured by the operator. Uninstall retains settings and state.

FRA network access is opt-in. When configured and invoked, the FRA client connects to the configured gateway/relay and uses the normal encrypted FRA protocol. Device/account enrollment is not performed by package installation. Do not enter credentials into untrusted workspaces. The hosted FRA server is a separately operated service with its own data handling and deployment controls.

This package does not configure telemetry or automatic update checks. Provider/model traffic occurs only if an operator configures and invokes a provider through Fleet or another selected integration. Consult component documentation for those independently configured connections.
