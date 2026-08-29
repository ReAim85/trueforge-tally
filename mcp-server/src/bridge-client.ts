// http client that talks to the tally bridge server rest api

export interface BridgeClientConfig {
  bridgeUrl: string;
  apiKey: string;
  agentId: string;
}

export interface EntityResult {
  agentId: string;
  entity: string;
  rowCount: number;
  rows: Record<string, unknown>[];
}

export interface ImportResult {
  agentId: string;
  status: string;
  masterId?: number;
  voucherId?: number;
  error?: string;
}

export class BridgeClient {
  private baseUrl: string;
  private apiKey: string;
  private agentId: string;

  constructor(config: BridgeClientConfig) {
    this.baseUrl = config.bridgeUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.agentId = config.agentId;
  }

  private async request(path: string, opts: RequestInit = {}): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...opts.headers,
      },
    });

    const body = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      const msg = (body.error as string) || `bridge returned ${res.status}`;
      throw new Error(msg);
    }

    return body;
  }

  private agentPath(suffix: string): string {
    return `/api/agents/${this.agentId}/${suffix}`;
  }

  async listAgents(): Promise<{ agentId: string; connectedAt: string }[]> {
    const data = await this.request('/api/agents');
    return data as { agentId: string; connectedAt: string }[];
  }

  async getEntity(
    entity: string,
    opts?: { company?: string; from?: string; to?: string },
  ): Promise<EntityResult> {
    const params = new URLSearchParams();
    if (opts?.company) params.set('company', opts.company);
    if (opts?.from) params.set('from', opts.from);
    if (opts?.to) params.set('to', opts.to);
    const qs = params.toString();
    const path = this.agentPath(entity) + (qs ? `?${qs}` : '');
    return (await this.request(path)) as EntityResult;
  }

  async createVoucher(payload: Record<string, unknown>): Promise<ImportResult> {
    return (await this.request(this.agentPath('vouchers'), {
      method: 'POST',
      body: JSON.stringify(payload),
    })) as ImportResult;
  }

  async createLedger(payload: Record<string, unknown>): Promise<ImportResult> {
    return (await this.request(this.agentPath('ledgers'), {
      method: 'POST',
      body: JSON.stringify(payload),
    })) as ImportResult;
  }

  async createStockItem(payload: Record<string, unknown>): Promise<ImportResult> {
    return (await this.request(this.agentPath('stockitems'), {
      method: 'POST',
      body: JSON.stringify(payload),
    })) as ImportResult;
  }

  async createStockGroup(payload: Record<string, unknown>): Promise<ImportResult> {
    return (await this.request(this.agentPath('stockgroups'), {
      method: 'POST',
      body: JSON.stringify(payload),
    })) as ImportResult;
  }

  async createUnit(payload: Record<string, unknown>): Promise<ImportResult> {
    return (await this.request(this.agentPath('units'), {
      method: 'POST',
      body: JSON.stringify(payload),
    })) as ImportResult;
  }

  async extractBill(
    image: string,
    opts?: { mimeType?: string; company?: string },
  ): Promise<Record<string, unknown>> {
    return (await this.request('/api/extract-bill', {
      method: 'POST',
      body: JSON.stringify({
        image,
        mimeType: opts?.mimeType,
        company: opts?.company,
      }),
    })) as Record<string, unknown>;
  }

  async processBill(
    image: string,
    opts?: { mimeType?: string; company?: string; autoPost?: boolean; tolerance?: number },
  ): Promise<Record<string, unknown>> {
    return (await this.request(this.agentPath('process-bill'), {
      method: 'POST',
      body: JSON.stringify({
        image,
        mimeType: opts?.mimeType,
        company: opts?.company,
        autoPost: opts?.autoPost ?? true,
        tolerance: opts?.tolerance ?? 1.0,
      }),
    })) as Record<string, unknown>;
  }
}
