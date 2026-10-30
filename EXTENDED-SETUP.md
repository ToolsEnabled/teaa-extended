# TEAA Extended setup and FRA client

Use the single `teaa` command. `teaa open --account https://YOUR-ACCOUNT --name YOUR-COMPUTER` opens a device claim against the configured HTTPS account origin. A person approves the displayed claim using that account service's normal terms and second-factor flow. `teaa accept --account https://YOUR-ACCOUNT --expect-email EMAIL_SHOWN_BY_RESERVATION` collects only the explicitly approved claim for the exact reserving email. `teaa status` reports enrollment only and does not enroll anything. These commands do not read mail, an account password, another device's credential or a provider login.

Self-hosted account origins are supported when they use HTTPS. The client derives the WSS rendezvous endpoint on the same hostname at `/v1/rendezvous`; this package does not configure a separate relay hostname. Account and relay traffic goes to the explicitly selected host. Use a dedicated TEAA prefix, state directory and Hub profile for each operator or account. Do not share or copy enrollment state between operators.

## Select the Desk Hub from a Laptop

Enroll Desk and Laptop against the same account origin with `teaa open --account https://ACCOUNT-ORIGIN --name Desk` and `--name Laptop`. Approve both claims on the signed-in account page, then run `teaa accept` on each computer with the reserved email shown there. At `https://ACCOUNT-ORIGIN/account/`, use **Your computers → Connections → Connect them** to pair Desk and Laptop. The account page identifies a connection by its two computer names.

The account service calls the connection routing identifier `relayPairId`. The device `pairId` printed by `teaa status` identifies only one enrolled computer and is not the relay pair. The account page creates the relay pair when you connect the computers. Its authenticated `/v1/devices/peers` response returns the exact `relayPairId`; the CLI reads that response using the enrolled computer's private credential, so you do not copy IDs or write profile JSON for the one-connection case.

On Desk, start the local Fleet Hub and FRA gateway with:

```sh
teaa hub start --actor local --account https://ACCOUNT-ORIGIN --machine desk
```

`ACCOUNT-ORIGIN` is the HTTPS origin in the account page address bar, without `/account/`. Desk's CLI queries its own enrolled account connection, writes the private gateway configuration, starts the local Fleet Hub and bundled FRA gateway, and waits for the gateway to join its paired relay. The optional `--machine` value is a local gateway label; it is not either pair identifier. `teaa hub status` reports the local Hub and gateway state, and `teaa hub stop` stops both.

On Laptop, select that Hub with:

```sh
teaa select-hub --account https://ACCOUNT-ORIGIN
```

Laptop independently discovers its unique `relayPairId` from its enrolled device credential and selects FRA as the Fleet upstream. The credential remains in the private device vault. ToolsEngine and Knowledge stay local. Use `teaa select-local` to restore Laptop's saved local Fleet choice.

If a computer has multiple account connections, select the desired Desk/Laptop connection by its names on **Your computers → Connections** and supply that connection's `relayPairId` with `--relay-pair ID` to the relevant CLI command. `relayPairId` is the routing field returned by the authenticated `/v1/devices/peers` response; it is not the device `pairId` from `teaa status`.

The selected device and gateway state live under the TEAA data root at `extended/devices/default` and `extended/hub-gateway`; Laptop's selected profile lives under the config root at `extended/hub.json`. Linux uses private modes; Windows validates native ACLs and reparse paths and creates fresh private state with the package security helper.
Reconnect defaults are 128 never-sent queued messages and a 20000 ms replay-initialize deadline. Overflow is -32003 and in-flight loss is -32001 uncertainty: sent calls are never replayed. Only never-sent queued calls replay after reconnection. Established-stream health probes run at most once per second with a two-second deadline, using an empty duplicate sequence that the gateway discards. Normal 20 s output polls and generic 60 s peer deadlines are unchanged. No total-outage bound or queued cancellation guarantee is claimed. Errors name a sanitized relay endpoint and safe cause, without tokens or arbitrary exception text.

Uninstall preserves config, enrollment and state. Revoke using the account/gateway owner's supported process, then explicitly remove any scratch state you own. Earlier preview folders are never imported or removed. This package does not deploy or restart a hosted account service or relay. Component versions and source identities are recorded in components.lock.json.
