import { parseAbi } from "viem";

// Minimal public interfaces; no company API or generated private SDK.
export const safeAbi = parseAbi([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getModulesPaginated(address start,uint256 pageSize) view returns (address[] array,address next)",
  "function isModuleEnabled(address module) view returns (bool)",
  "function getStorageAt(uint256 offset,uint256 length) view returns (bytes)",
  "function approvedHashes(address owner,bytes32 hash) view returns (uint256)",
  "function approveHash(bytes32 hash)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
  "event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash,uint256 payment)",
]);
export const legacySafeEvents = parseAbi([
  "event ExecutionSuccess(bytes32 txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 txHash,uint256 payment)",
]);

// Deployed Candide v0.0.1 uses FOUR arguments for confirmRecovery. Newer
// upstream source adds a nonce: never substitute that ABI for deployed code.
export const recoveryAbi = parseAbi([
  "function NAME() view returns (string)",
  "function VERSION() view returns (string)",
  "function getGuardians(address wallet) view returns (address[])",
  "function isGuardian(address wallet,address guardian) view returns (bool)",
  "function threshold(address wallet) view returns (uint256)",
  "function nonce(address wallet) view returns (uint256)",
  "function getRecoveryRequest(address wallet) view returns ((uint256 guardiansApprovalCount,uint256 newThreshold,uint64 executeAfter,address[] newOwners))",
  "function getRecoveryApprovals(address wallet,address[] newOwners,uint256 newThreshold) view returns (uint256)",
  "function hasGuardianApproved(address wallet,address guardian,address[] newOwners,uint256 newThreshold) view returns (bool)",
  "function confirmRecovery(address wallet,address[] newOwners,uint256 newThreshold,bool execute)",
  "function multiConfirmRecovery(address wallet,address[] newOwners,uint256 newThreshold,(address signer,bytes signature)[] signatures,bool execute)",
  "function executeRecovery(address wallet,address[] newOwners,uint256 newThreshold)",
  "function finalizeRecovery(address wallet)",
  "function cancelRecovery()",
]);
export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export const vaultAbi = parseAbi([
  "function asset() view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function redeem(uint256 shares,address receiver,address owner) returns (uint256)",
]);
export const aaveAbi = parseAbi([
  "function POOL() view returns (address)",
  "function UNDERLYING_ASSET_ADDRESS() view returns (address)",
  "function withdraw(address asset,uint256 amount,address to) returns (uint256)",
]);
export const delayAbi = parseAbi([
  "function avatar() view returns (address)",
  "function target() view returns (address)",
  "function txCooldown() view returns (uint256)",
  "function txExpiration() view returns (uint256)",
  "function txNonce() view returns (uint256)",
  "function queueNonce() view returns (uint256)",
  "function getTxCreatedAt(uint256 nonce) view returns (uint256)",
  "function getTxHash(uint256 nonce) view returns (bytes32)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation) view returns (bytes32)",
  "function isModuleEnabled(address module) view returns (bool)",
  "function getModulesPaginated(address start,uint256 pageSize) view returns (address[] array,address next)",
  "function execTransactionFromModule(address to,uint256 value,bytes data,uint8 operation) returns (bool)",
  "function executeNextTx(address to,uint256 value,bytes data,uint8 operation)",
  "function skipExpired()",
  "event TransactionAdded(uint256 indexed queueNonce,bytes32 indexed txHash,address to,uint256 value,bytes data,uint8 operation)",
]);
