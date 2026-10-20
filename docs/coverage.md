# Coverage and verification

This is an implementation preview, not a claim that every historical deployment has been tested with a live position. The table distinguishes implemented routes from the evidence collected. No production transaction or customer signing key was used.

## Account and card paths

| Path | Implementation | Evidence |
| --- | --- | --- |
| Safe 1.3.0 / 1.4.1 | Public singleton runtime allowlist; owners, threshold, guards, modules, native balance | Actual Safe 1.4.1 bytecode in local Anvil; 1.3.0 event-layout unit checks |
| Candide deployed 0.0.1 | Guardian EIP-712 approvals, initiation, actual immutable waiting period, finalization, owner cancellation | Full approval → delay → ownership change → ERC-20 transfer on actual deployed recovery bytecode |
| Multisig Safe | On-chain hash approvals plus sorted owner signatures; no hosted transaction service | Actual 2-of-2 Safe execution locally; insufficient approvals rejected |
| Legacy EOA | Read-only inspection; only the matching external signer can send | Wrong signer rejected; native transfer locally |
| Gnosis Pay Delay | Verify clone/controller/target; queue, cooldown, permissionless execution, expiry skip | Actual Delay creation bytecode and cloned runtime locally; early execution and stale queue rejected; token recipient balance checked |
| Unknown module/version; undeployed Safe | Unsupported paths stay unavailable; an address with no code is not assumed recoverable | Runtime mismatch, wrong chain, stale nonce, former owner and invalid target tests |

Recovery requires a usable configured owner/guardian. The tool cannot turn a Picnic login, an account address, or a balance into signing authority. Counterfactual Safe deployment and Safe passkey-contract signatures are not implemented. Recover to an ordinary external owner wallet first when using the supported guardian path.

## Current investments

| Product | Implemented exit | Nonzero-balance evidence |
| --- | --- | --- |
| Savings sDAI, Gnosis | ERC-4626 redeem to receiver | Real Gnosis fork: deposit and redemption |
| Aave EURe, Gnosis | Pool withdrawal after validating aToken pool/underlying | Real Gnosis fork: supply and withdrawal; corrected obsolete EURe address |
| stBRLA, Polygon | `unstake(from,to,shares)`; rejects paused state | Real Polygon fork: stake and unstake |
| Aave USDC, Polygon | Validated pool withdrawal | Real Polygon fork: supply and withdrawal |
| Aave USDT / USDC.e / EURS, Polygon | Same validated pool adapter | Interface/catalogue checks; separate nonzero fixtures not yet run |
| Covered sDAI | Cancel pending deposit; claim settled deposit shares; request redemption; discover pending IDs from events; permissionless settlement; claim sDAI | Real Gnosis fork: pending-deposit cancellation and existing-share request → wait → settlement → claim |
| Stader MaticX | Exact approval, liquidity check, delayed request, index-bound claim; receipt transfer alternative | Real Polygon fork: live insufficient-liquidity refusal; local-only liquidity replenishment then request/claim. **This does not establish current production liquidity.** |
| Moonwell mwcbBTC, Base | ERC-4626 redeem up to current `maxRedeem` | Real Base fork with nonzero deposit and available-share redemption; full balance can exceed the immediately available maximum |
| MAMO direct staking, Base | Withdraw principal to account; current and historical deployment catalogue | Real Base fork for current MultiRewards staking/withdrawal; historical deployment not separately tested |
| Owned MAMO staking strategies | Registry discovery; owner/token checks; principal and rewards withdrawal | Implemented from public contracts; dedicated nonzero strategy fixture still required |
| Lido wstETH on Polygon / JitoSOL on Arbitrum | Transfer position token | Generic ERC-20 path; native ETH/SOL redemption requires a separate cross-chain operation and is not represented as complete |
| Tokenized stocks, ETFs, portfolios | Local catalogue of 447 BSC token addresses; transfer exact units | Generic ERC-20 path; no stock sale, issuer redemption, off-chain unsettled order recovery or bypass of issuer restrictions |

The fork suite prints starting blocks. Fixture deposits, impersonation, time advancement and liquidity replenishment happen only inside disposable local Anvil instances. A passing test is not evidence of future liquidity, unchanged proxy implementations, or issuer permission for every recipient. Transactions are simulated again against the user's current RPC.

## Historical baskets

The bundled catalogue retains all 2,244 historical entries, including inactive products, and restores two missing token references from on-chain reads. Search covers 2,246 records and 21 asset types. It is loaded locally, without an indexer or backend. NFT ownership can be enumerated in bounded pages; failed reads stay visible.

Implemented basket bridge exits cover Aave V2, Autofarm, Harvest, Beefy, Clearpool, Balancer liquidity, Uniswap V2-style liquidity, Kyber liquidity, Curve liquidity, Gamma, gauges, MasterChef staking, Compound V3, Stargate liquidity, and Jarvis reward claims. LP calls require explicit minimum outputs. Nested receipts remain in the basket via `editPortfolio` so the next layer can be exited; terminal outputs are withdrawn to the NFT owner. Native POL and arbitrary transferable ERC-20 receipts can also be withdrawn.

Tetu's historical bridge deployment is absent from the catalogue. Its fallback is to move the vault receipt to the NFT owner, then call the Tetu vault's `withdraw` from that account. Jarvis synthetic tokens, historical Balancer swap-based positions and illiquid stable tokens can be transferred as-is: conversion routes are not included.

Historical route tests verify catalogue completeness and encoding of allowed exit methods across the configured entries, not successful execution of every historical pool. Those deployments need a representative fork matrix and code/source review before treating broad legacy coverage as production-validated. The catalogue is not an exhaustive discovery index for assets a user acquired outside Picnic. Ownership and balances must be read from the chain; a selected catalogue item alone proves neither.

## Browser and release checks

The local UI was exercised in Portuguese: inspect a fixture Safe using a custom loopback RPC, prepare a 6-decimal ERC-20 transfer, review the decoded recipient/amount, sign through an isolated development provider, and confirm the recipient received exactly 12,345,678 raw units. The app confirmed execution. Desktop and 390px mobile layouts were inspected. Wallet extension console conflicts led to adding EIP-6963 provider selection. No real wallet was connected or signed.

The deterministic local suite covers recovery/card/multisig/EOA flows and amount, queue, transport, progress-import and catalogue invariants. The separate fork suite checks real protocol bytecode. CI runs type checking, local tests, production build, dependency audit, and archive creation. Fork tests are opt-in because they require public archive RPC availability.

Remaining release work is explicit: independently review the signing/recovery code, test additional Safe/module deployments and hardware wallets, add representative nonzero legacy/owned-MAMO fixtures, and perform a wider usability review. The static tool and documented fallback transfers are implemented; universal recovery and every historical redemption have not been established.
