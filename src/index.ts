import "dotenv/config";
import { BinanceClient, type Balance, type WalletSection } from "./binance.js";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function formatAmount(value: string): string {
  const num = Number(value);
  if (Number.isNaN(num)) {
    return value;
  }
  return num.toLocaleString("en-US", {
    maximumFractionDigits: 8,
  });
}

function printBalances(balances: Balance[]): void {
  if (balances.length === 0) {
    console.log("  (no balance)");
    return;
  }

  console.log("  Asset\t\tFree\t\t\tLocked");
  for (const balance of balances) {
    console.log(
      `  ${balance.asset.padEnd(12)}\t${formatAmount(balance.free).padEnd(16)}\t${formatAmount(balance.locked)}`,
    );
  }
}

function printSection(section: WalletSection): void {
  console.log(`\n[${section.name}]`);

  if (section.error) {
    console.log(`  Skipped: ${section.error}`);
    return;
  }

  printBalances(section.balances);
}

async function main(): Promise<void> {
  const apiKey = requireEnv("BINANCE_API_KEY");
  const apiSecret = requireEnv("BINANCE_API_SECRET");
  const baseUrl = process.env.BINANCE_BASE_URL?.trim() || "https://api.binance.com";

  if (baseUrl.includes("testnet")) {
    console.warn("Warning: BINANCE_BASE_URL points to testnet, not mainnet.\n");
  }

  const client = new BinanceClient(apiKey, apiSecret, baseUrl);

  console.log("Fetching all Binance mainnet balances...\n");

  const sections = await client.getAllMainnetBalances();
  const accessibleSections = sections.filter((section) => !section.error);
  const failedSections = sections.filter((section) => section.error);

  for (const section of sections) {
    printSection(section);
  }

  try {
    const walletTotals = await client.getWalletTotalsInUsdt();
    if (walletTotals.length > 0) {
      console.log("\n[Wallet totals in USDT]");
      for (const wallet of walletTotals) {
        console.log(`  ${wallet.walletName.padEnd(18)} ${formatAmount(wallet.balance)} USDT`);
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`\n[Wallet totals in USDT]`);
    console.log(`  Skipped: ${message}`);
  }

  const totalAssets = accessibleSections.reduce(
    (count, section) => count + section.balances.length,
    0,
  );

  console.log("\n---");
  console.log(`Wallets checked: ${sections.length}`);
  console.log(`Wallets accessible: ${accessibleSections.length}`);
  console.log(`Assets with balance: ${totalAssets}`);

  if (failedSections.length === sections.length) {
    throw new Error(
      "All wallet requests failed. Check API key permissions (Enable Reading), IP whitelist, and mainnet keys.",
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nBalance check failed: ${message}`);
  process.exit(1);
});
