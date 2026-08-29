// all read-only tools for fetching data from tally
// these dont need approval since they only read

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BridgeClient } from '../bridge-client.js';

const companyParam = z.object({
  company: z.string().optional().describe('company name, defaults to the active company in tally'),
});

const dateRangeParams = z.object({
  company: z.string().optional().describe('company name, defaults to the active company in tally'),
  from: z.string().optional().describe('start date in yyyy-mm-dd format'),
  to: z.string().optional().describe('end date in yyyy-mm-dd format'),
});

const readAnnotations = {
  readOnlyHint: true as const,
  destructiveHint: false as const,
  idempotentHint: true as const,
  openWorldHint: false as const,
};

interface SimpleEntity {
  name: string;
  entity: string;
  description: string;
  hasDateRange: boolean;
}

const entities: SimpleEntity[] = [
  { name: 'list_companies', entity: 'companies', description: 'list all companies open in tallyprime', hasDateRange: false },
  { name: 'get_ledgers', entity: 'ledgers', description: 'get all ledger accounts with their parent group and opening balance', hasDateRange: false },
  { name: 'get_groups', entity: 'groups', description: 'get all account groups in the chart of accounts', hasDateRange: false },
  { name: 'get_stock_items', entity: 'stockitems', description: 'get all stock/inventory items with unit, rate, and quantity', hasDateRange: false },
  { name: 'get_stock_groups', entity: 'stockgroups', description: 'get stock item groups', hasDateRange: false },
  { name: 'get_stock_categories', entity: 'stockcategories', description: 'get stock categories', hasDateRange: false },
  { name: 'get_voucher_types', entity: 'vouchertypes', description: 'get all voucher types like sales, purchase, payment, receipt, journal', hasDateRange: false },
  { name: 'get_cost_centres', entity: 'costcentres', description: 'get cost centres', hasDateRange: false },
  { name: 'get_cost_categories', entity: 'costcategories', description: 'get cost categories', hasDateRange: false },
  { name: 'get_currencies', entity: 'currencies', description: 'get currencies defined in tally', hasDateRange: false },
  { name: 'get_units', entity: 'units', description: 'get measurement units like nos, kg, pcs', hasDateRange: false },
  { name: 'get_godowns', entity: 'godowns', description: 'get godowns/warehouses/storage locations', hasDateRange: false },
  { name: 'get_vouchers', entity: 'vouchers', description: 'get vouchers (transactions) with optional date filter', hasDateRange: true },
  { name: 'get_profit_and_loss', entity: 'profitandloss', description: 'get the profit and loss statement with optional date range', hasDateRange: true },
  { name: 'get_balance_sheet', entity: 'balancesheet', description: 'get the balance sheet with optional date range', hasDateRange: true },
  { name: 'get_ratio_analysis', entity: 'ratioanalysis', description: 'get financial ratio analysis with optional date range', hasDateRange: true },
];

export function registerReadTools(server: McpServer, bridge: BridgeClient): void {
  for (const e of entities) {
    const schema = e.hasDateRange ? dateRangeParams : companyParam;

    server.tool(
      e.name,
      e.description,
      schema.shape,
      async (params) => {
        const result = await bridge.getEntity(e.entity, {
          company: params.company,
          from: 'from' in params ? params.from as string | undefined : undefined,
          to: 'to' in params ? params.to as string | undefined : undefined,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          _meta: readAnnotations,
        };
      },
    );
  }
}
