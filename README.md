# Picnic Recovery

Independent, open-source access to Picnic Safe and legacy EOA accounts and on-chain asset exits. Run it locally or host the static build yourself. No Picnic login, API, Magic session, Deframe API, bundler, paymaster or hosted recovery service is used.

**Implementation preview.** Recovery and card flows have local contract integration tests; selected investment exits have nonzero-balance fork tests. The historical catalogue is broader than the tested deployment coverage. See [coverage and verification](docs/coverage.md) before using a route. This repository does not guarantee recovery of every account.

## Run from source

Node 22.12+; no environment variables or credentials:

```sh
npm ci --ignore-scripts
npm run build
node scripts/serve.mjs
```

Open `http://127.0.0.1:4173`. The build contains its own scripts, styles, ABI fragments and catalogues. Keep a copy of the repository and a built archive: package registries, GitHub and the hosted page are not required to run an already-built copy. The archive still requires a local HTTP server; `scripts/serve.mjs` uses only Node built-ins.

## Use

0. **Automatic diagnosis.** Use the connect button in step 0: the external wallet address is filled automatically and diagnosis begins immediately. Switching wallet accounts updates the diagnosis too. Under Advanced, you can instead enter or select a separate Safe/card address; that explicit target is preserved when connecting its owner or guardian. Use ‘Use connected wallet’ to return to following the wallet. All ten supported networks are checked concurrently in the background without a signature; entering an address manually does not require a wallet connection. Results appear incrementally, including native/token balances, known investments and pending requests, recovery state, and legacy basket ownership. Ownership is checked here; gas checks happen only in Prepare wallets. Review Assets and Needs attention, then use Next step; its network is carried forward automatically. Failed reads remain explicitly unverified.
   **Passkey recovery sub-step.** Shown inside diagnosis only when a recognized Picnic Safe WebAuthn signer is detected and access recovery is needed. Passkey accounts recover using their configured guardian key imported privately into an external wallet. Approve a new owner, start recovery, wait the contract's delay, then finalize. An existing owner can skip recovery. The original Picnic passkey is domain-bound and is not read by this tool. Recovery transactions already require native gas in each sending wallet.
1. **Prepare wallets.** One view lists every diagnosed holding on every network, grouped by network with its logo: native coins, ERC-20s, investment positions and pending requests, legacy baskets, MAMO strategies and verified custom tokens. Tick or untick whole networks or single assets; select all/none and a selected count are shown. Use the owner wallet connected in step 0; return there to change the connection through the standard ConnectKit modal. The app discovers installed browser wallets through Wagmi/EIP-6963, without a WalletConnect project or relay. For each selected network, the app automatically checks whether the connected wallet is an owner and reads its native balance in parallel (with retry/refresh and the block read); unselected networks are not checked and never block. Networks whose reading is incomplete are disclosed and can be retried; unknown balances are not treated as empty. Set one destination for all networks. Tokens and gas on another network cannot pay these fees. A positive balance is not a promise that every withdrawal is affordable: each transaction is simulated/estimated again and the wallet shows its fee. For Safe execution, the external sender pays; a legacy EOA pays its own gas and must retain a reserve when withdrawing native coins. Continue requires at least one selected asset, every selected network ready and a valid destination.
2. **Move funds.** Only the assets selected in Prepare wallets are listed; switch between selected networks or edit the selection, which is kept when you return. Unticked assets are hidden from investments and legacy baskets and refused by the manual transfer form. After entering this step, assets found later (for example by a rescan) arrive unselected until you tick them. Open a withdrawal from the token/network/balance table, or choose balances/tokens, card, investments or legacy baskets. Missing ERC-20s can be added in step 0 or Prepare wallets by network and contract address; their verified balance and decimals appear for this session. Review destination, amount and decoded call for each operation; nothing is sent automatically. Safe transactions use nonce-bound EIP-712 signatures followed by a wallet transaction. For a card, recover its controller first, queue the transfer, wait the cooldown, then execute the queue head. Exit investments one layer at a time; some requests require later settlement/claim. Transferable receipts can be moved without selling them.

Export public progress before changing browsers. Pending transaction hashes remain pending after a timeout; inspect receipts before repeating an action. Importing progress never imports a signing key or changes on-chain ownership.

Never enter a seed, private key, OTP or Picnic password into this app. Import a recovered signing key privately into a wallet you trust. Without an existing owner/guardian key or another configured on-chain recovery authority, an address and its balance alone cannot authorize a withdrawal. Keep an independent owner or guardian provisioned **before** Picnic becomes unavailable.

## Dependencies and limits

- An Ethereum-compatible browser wallet, a working RPC and native gas are required. The RPC observes public account queries. Its URL is not persisted or exported. ConnectKit can also resolve public ENS names/avatars and show wallet balances using the configured public chain transports; recovery and asset reads use the RPC chosen in the app.
- Recovery recognizes the deployed Candide `0.0.1` runtime (including immutable delay variants). Safe `1.3.0`/`1.4.1` singleton runtime hashes are pinned to Safe's public deployment registry. Unknown deployments fail closed.
- Guards, token restrictions, protocol pauses, liquidity shortages and issuer restrictions still apply. A transferable investment token is not the same as redemption into its underlying asset.
- No mandatory swaps, fiat payouts, bridge services, price API, analytics, remote fonts or CDN-loaded JavaScript. Existing off-chain unsettled orders are outside the on-chain balance the app can move.
- Multisig owners register approvals of the same Safe transaction hash on-chain. Every owner must reproduce the same chain, Safe, nonce and call. No Safe Transaction Service is required.
- Progress is public metadata, stored in this browser. It is not a backup of keys, a guaranteed complete asset inventory, or proof of ownership.

## Develop and verify

Install [Foundry/Anvil](https://getfoundry.sh/) for contract integration tests.

```sh
npm run check
npm test
npm run test:fork   # public RPC read access; all writes stay inside Anvil
npm run build
npm run release:archive  # requires a clean, committed source tree
```

For browser development, run `node scripts/demo-chain.mjs`, then `npm run dev` and open `http://127.0.0.1:5173/?demo=1`. The script prints fictitious Safe/token addresses and the loopback RPC. Select “Anvil local (test only)” in the ConnectKit modal. Demo signing uses only that Anvil instance and is removed from production builds. Do not import Anvil's public test keys into a real wallet.

[Architecture](docs/architecture.md) · [Coverage](docs/coverage.md) · [Third-party notices](NOTICE.md)

MIT for original application code. Test bytecode retains its upstream licenses. This project implements the independent-tool workstream in [Picnic #10622](https://github.com/usePicnic/picnic/issues/10622).
