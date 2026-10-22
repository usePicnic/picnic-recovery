import type { Address } from "viem";

export type ProductKind = "erc4626" | "aave" | "stbrla" | "covered" | "stader" | "staking" | "receipt";
export type Product = {
  id: string; chainId: number; name: string; address: Address; kind: ProductKind;
  source: string; pool?: Address; asset?: Address; note?: string;
};
export const products: Product[] = [
  { id: "covered-sdai", chainId: 100, name: "Caixinha dólar · Covered sDAI", address: "0x0AC34fe133BdE3A2eF589a18A4E10b6a7d253829", kind: "covered", asset: "0xaf204776c7245bF4147c2612BF6e5972Ee483701", source: "https://gnosisscan.io/address/0x0AC34fe133BdE3A2eF589a18A4E10b6a7d253829#code" },
  { id: "stbrla", chainId: 137, name: "Caixinha real · stBRLA", address: "0x2305256fB0a361A4751F6C9A490768F24CccBBA0", kind: "stbrla", asset: "0xE6A537a407488807F0bbeb0038B79004f19DDDFb", source: "https://github.com/Ada-Capital/BRLA-Audit/blob/main/stBRLA.sol" },
  { id: "aave-eure", chainId: 100, name: "Caixinha euro · Aave EURe", address: "0xEdBC7449a9b594CA4E053D9737EC5Dc4CbCcBfb2", kind: "aave", pool: "0xb50201558B00496A145fE76f7424749556E326D8", asset: "0xcB444e90D8198415266c6a2724b7900fb12FC56E", source: "https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Gnosis.sol" },
  { id: "sdai", chainId: 100, name: "Savings xDAI · sDAI", address: "0xaf204776c7245bF4147c2612BF6e5972Ee483701", kind: "erc4626", source: "https://github.com/gnosis/sdai" },
  { id: "mw-cbbtc", chainId: 8453, name: "Moonwell · cbBTC", address: "0x543257eF2161176D7C8cD90BA65C2d4CaEF5a796", kind: "erc4626", asset: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", source: "https://github.com/moonwell-fi/mamodocs/blob/main/technical/contract-addresses.md" },
  ...([
    ["aave-usdt", "Aave · USDT", "0x6ab707Aca953eDAeFBc4fD23bA73294241490620", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"],
    ["aave-usdc", "Aave · USDC", "0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"],
    ["aave-usdce", "Aave · USDC.e (legacy)", "0x625E7708f30cA75bfd92586e17077590C60eb4cD", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"],
    ["aave-eurs", "Aave · EURS", "0x38d693cE1dF5AaDF7bC62595A37D667aD57922e5", "0xE111178A87A3BFf0c8d18DECBa5798827539Ae99"],
  ] as const).map(([id, name, address, asset]) => ({ id, name, address, asset, chainId: 137, kind: "aave" as const, pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as Address, source: "https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Polygon.sol" })),
  { id: "maticx", chainId: 137, name: "Stader · MaticX", address: "0xfa68FB4628DFF1028CFEc22b4162FCcd0d45efb6", pool: "0xfd225C9e6601C9d38d8F98d8731BF59eFcF8C0E3", kind: "stader", source: "https://github.com/stader-labs/maticX/blob/main/contracts/ChildPool.sol" },
  { id: "wsteth", chainId: 137, name: "Lido · wstETH", address: "0x03b54a6e9a984069379fae1a4fc4dbae93b3bccd", kind: "receipt", note: "Transfer the position on this network. Native redemption is a separate cross-chain operation.", source: "https://docs.lido.fi/deployed-contracts/" },
  { id: "jitosol", chainId: 42161, name: "JitoSOL", address: "0x83e1d2310Ade410676B1733d16e89f91822FD5c3", kind: "receipt", note: "Transfer the position on Arbitrum. This is not a redemption into native SOL.", source: "https://arbiscan.io/address/0x83e1d2310Ade410676B1733d16e89f91822FD5c3#code" },
  { id: "mamo", chainId: 8453, name: "MAMO · staking", address: "0x7855B0821401Ab078f6Cf457dEAFae775fF6c7A3", kind: "staking", source: "https://github.com/moonwell-fi/mamo-contracts/blob/main/src/MultiRewards.sol" },
  { id: "mamo-legacy", chainId: 8453, name: "MAMO · legacy staking", address: "0xEC9aBc51Bf7D7A91a60C32Dea861f8029b1A7791", kind: "staking", source: "https://github.com/moonwell-fi/mamo-contracts/blob/main/addresses/8453.json" },
];
