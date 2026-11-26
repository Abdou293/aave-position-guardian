// Minimal read-only ABIs: only the view functions this project calls.
// Signatures follow the official Aave V3 interfaces (github.com/aave-dao/aave-v3-origin:
// IPool, IPoolDataProvider, IAaveOracle) and Multicall3 (github.com/mds1/multicall3).
// There are deliberately NO write functions here.
import { parseAbi } from 'viem';

export const poolAbi = parseAbi([
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getUserEMode(address user) view returns (uint256)',
]);

export const dataProviderAbi = parseAbi([
  'struct TokenData { string symbol; address tokenAddress; }',
  'function getAllReservesTokens() view returns (TokenData[])',
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
]);

export const oracleAbi = parseAbi([
  'function BASE_CURRENCY_UNIT() view returns (uint256)',
  'function getAssetsPrices(address[] assets) view returns (uint256[])',
]);

export const multicall3Abi = parseAbi(['function getCurrentBlockTimestamp() view returns (uint256)']);
