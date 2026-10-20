# Architecture and trust boundaries

The browser reads a user-selected JSON-RPC endpoint, builds a restricted protocol call locally, asks the user's EIP-1193 wallet to sign/send, then checks the receipt and relevant resulting state. The static server stores no keys and has no application API. EIP-6963 discovery handles multiple wallet extensions without choosing whichever extension overwrote `window.ethereum` last.

`src/core/inspect.ts` reads Safe owners, threshold, nonce, modules, guards and canonical singleton runtime at a pinned block. Recovery modules are accepted only when their runtime matches the known deployed version after normalizing the immutable delay. The observed delay is shown to the user; it is never substituted with a product default.

`actions.ts` builds ordinary Safe CALL operations. Owner EIP-712 signatures bind the nonce, destination, value, calldata, operation, gas and refund fields. Other owners can approve the exact Safe hash on-chain. Simulation and gas estimation happen before broadcast; state is rechecked before sending. A review is not a transaction and simulation cannot reserve future chain state. Safe internal execution events are checked independently of the outer receipt status. ERC-20 Transfer logs and balance changes verify expected receipts; native receipts use balance changes, which cannot prove attribution against concurrent external transfers.

Guardian approvals use `multiConfirmRecovery` with a nonce-bound EIP-712 signature. The deployed module's legacy `confirmRecovery` ABI has four arguments and does not bind a nonce; the tool does not use it. Recovery approval, initiation and finalization are separate transactions. Finalization checks owners, threshold and cleared recovery state.

`card.ts` recognizes EIP-1167 clones of the documented Gnosis Pay Delay implementations and validates avatar, target and enabled controller. The Picnic Safe queues a transaction as the enabled module. Queue events are reconstructed and matched against stored hashes. Dispatch is permissionless, but only decodable native/ERC-20 transfer calls are executable here. Delegatecall and arbitrary unknown queue entries are refused. Contract cooldown/expiry controls execution; the browser rechecks the queue head before submission. Concurrent miners can still change a queue after the wallet signs.

`investments.ts`, `mamo.ts`, and `legacy-routes.ts` contain exits only. Historical basket bridges run in the NFT wallet's context through `withdrawPortfolio`; the connected Safe must own the NFT. LP routes require explicit minimum outputs, and protocol simulation can reject stale liquidity. Harvest/Balancer/Jarvis output metadata is resolved on-chain when inspected. The tool never treats a failed read as a zero balance.

`progress.ts` imports only a small versioned schema: chain/address labels, transaction hashes, status, and public receipt expectations. It strips unknown fields, validates addresses and caps file size. No RPC URL or signatures are exported. Hashes are persisted immediately after the wallet returns them, before confirmation waiting. A provider that broadcasts but throws before returning a hash remains an unavoidable ambiguous-submission case: inspect wallet activity before repeating.

Builds are static Vite assets with relative paths. The packaged archive has deterministic tar metadata, SHA-256 checksums for every included file and the source commit in `BUILD.json`. Rebuild from the lockfile and compare checksums; hosting is optional.

## Wallet connection and three-step flow

The interface groups access recovery, sender/destination/gas preparation, and asset exits. ConnectKit upstream supplies the external-wallet modal (Picnic uses a fork of this same library); Wagmi discovers injected providers. The selected connector supplies the EIP-1193 provider to the existing signing functions. Changing wallet/account/network invalidates the transaction review. React 18 is pinned to match ConnectKit's supported peer range. WalletConnect QR relays are not configured; an installed wallet or wallet browser is required. No Picnic connector keys are reused.

Native balance checks are scoped to chain, RPC, inspected account and connected sender. They are reset when those inputs change and show a block number, not a guaranteed future gas budget. Recovery approvals/start/finalization need gas before the preparation step too. Direct Safe execution charges the external transaction sender; the Safe/card need no separate gas deposit for this path. EOA native withdrawals must retain gas.

The demo provider is announced through EIP-6963 only in local Vite development with `?demo=1`. It is selected through the same ConnectKit modal and Wagmi connector as installed wallets, and never overrides the browser's wallet. Its RPC verifies local Anvil before serving requests.

Transitive `decode-uri-component` and older `uuid` releases are overridden to patched versions to keep the connector dependency tree free of known audit findings. Only injected connectors are configured; relay/mobile SDK connector paths are not enabled or claimed as tested.
