import crypto from "node:crypto";

const SPOT_BASE_URL = "https://api.binance.com";
const USDT_FUTURES_BASE_URL = "https://fapi.binance.com";
const COIN_FUTURES_BASE_URL = "https://dapi.binance.com";

export type Balance = {
  asset: string;
  free: string;
  locked: string;
};

export type WalletSection = {
  name: string;
  balances: Balance[];
  error?: string;
};

export class BinanceClient {
  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly spotBaseUrl: string = SPOT_BASE_URL,
  ) {}

  private sign(query: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(query).digest("hex");
  }

  private buildSignedQuery(extraParams: Record<string, string> = {}): string {
    const params = new URLSearchParams({
      ...extraParams,
      timestamp: String(Date.now()),
      recvWindow: "5000",
    });
    const query = params.toString();
    return `${query}&signature=${this.sign(query)}`;
  }

  private async signedRequest<T>(
    method: "GET" | "POST",
    baseUrl: string,
    path: string,
    extraParams: Record<string, string> = {},
  ): Promise<T> {
    const signedQuery = this.buildSignedQuery(extraParams);
    const url = method === "GET" ? `${baseUrl}${path}?${signedQuery}` : `${baseUrl}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        "X-MBX-APIKEY": this.apiKey,
        ...(method === "POST"
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body: method === "POST" ? signedQuery : undefined,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Binance API error (${response.status}): ${body}`);
    }

    return (await response.json()) as T;
  }

  private nonZero(balances: Balance[]): Balance[] {
    return balances.filter((balance) => {
      const total = Number(balance.free) + Number(balance.locked);
      return total > 0;
    });
  }

  async getSpotBalances(): Promise<Balance[]> {
    const data = await this.signedRequest<{ balances: Balance[] }>(
      "GET",
      this.spotBaseUrl,
      "/api/v3/account",
    );
    return this.nonZero(data.balances);
  }

  async getFundingBalances(): Promise<Balance[]> {
    const data = await this.signedRequest<
      Array<{ asset: string; free: string; locked: string }>
    >("POST", this.spotBaseUrl, "/sapi/v1/asset/get-funding-asset");

    return this.nonZero(
      data.map((item) => ({
        asset: item.asset,
        free: item.free,
        locked: item.locked,
      })),
    );
  }

  async getCrossMarginBalances(): Promise<Balance[]> {
    const data = await this.signedRequest<{
      userAssets: Array<{
        asset: string;
        free: string;
        locked: string;
        netAsset: string;
      }>;
    }>("GET", this.spotBaseUrl, "/sapi/v1/margin/account");

    return this.nonZero(
      data.userAssets.map((item) => ({
        asset: item.asset,
        free: item.netAsset,
        locked: "0",
      })),
    );
  }

  async getIsolatedMarginBalances(): Promise<Balance[]> {
    const data = await this.signedRequest<{
      assets: Array<{
        symbol: string;
        baseAsset: { asset: string; free: string; locked: string };
        quoteAsset: { asset: string; free: string; locked: string };
      }>;
    }>("GET", this.spotBaseUrl, "/sapi/v1/margin/isolated/account");

    const balances: Balance[] = [];

    for (const pair of data.assets) {
      for (const asset of [pair.baseAsset, pair.quoteAsset]) {
        const total = Number(asset.free) + Number(asset.locked);
        if (total > 0) {
          balances.push({
            asset: `${asset.asset} (${pair.symbol})`,
            free: asset.free,
            locked: asset.locked,
          });
        }
      }
    }

    return balances;
  }

  async getUsdtFuturesBalances(): Promise<Balance[]> {
    const data = await this.signedRequest<
      Array<{ asset: string; balance: string; availableBalance: string }>
    >("GET", USDT_FUTURES_BASE_URL, "/fapi/v2/balance");

    return this.nonZero(
      data.map((item) => ({
        asset: item.asset,
        free: item.availableBalance,
        locked: String(Math.max(0, Number(item.balance) - Number(item.availableBalance))),
      })),
    );
  }

  async getCoinFuturesBalances(): Promise<Balance[]> {
    const data = await this.signedRequest<
      Array<{ asset: string; balance: string; availableBalance: string }>
    >("GET", COIN_FUTURES_BASE_URL, "/dapi/v1/balance");

    return this.nonZero(
      data.map((item) => ({
        asset: item.asset,
        free: item.availableBalance,
        locked: String(Math.max(0, Number(item.balance) - Number(item.availableBalance))),
      })),
    );
  }

  async getWalletTotalsInUsdt(): Promise<Array<{ walletName: string; balance: string }>> {
    const data = await this.signedRequest<
      Array<{ walletName: string; balance: string; activate: boolean }>
    >("GET", this.spotBaseUrl, "/sapi/v1/asset/wallet/balance", {
      quoteAsset: "USDT",
    });

    return data
      .filter((wallet) => wallet.activate && Number(wallet.balance) > 0)
      .map((wallet) => ({
        walletName: wallet.walletName,
        balance: wallet.balance,
      }));
  }

  async getAllMainnetBalances(): Promise<WalletSection[]> {
    const wallets: Array<{ name: string; fetch: () => Promise<Balance[]> }> = [
      { name: "Spot", fetch: () => this.getSpotBalances() },
      { name: "Funding", fetch: () => this.getFundingBalances() },
      { name: "Cross Margin", fetch: () => this.getCrossMarginBalances() },
      { name: "Isolated Margin", fetch: () => this.getIsolatedMarginBalances() },
      { name: "USDT-M Futures", fetch: () => this.getUsdtFuturesBalances() },
      { name: "COIN-M Futures", fetch: () => this.getCoinFuturesBalances() },
    ];

    const sections: WalletSection[] = [];

    for (const wallet of wallets) {
      try {
        sections.push({
          name: wallet.name,
          balances: await wallet.fetch(),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        sections.push({
          name: wallet.name,
          balances: [],
          error: message,
        });
      }
    }

    return sections;
  }
}
