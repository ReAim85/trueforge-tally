// write tools that create data in tally
// all of these need human approval before executing

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BridgeClient } from '../bridge-client.js';

export function registerWriteTools(server: McpServer, bridge: BridgeClient): void {

  // create a voucher (sales, purchase, payment, receipt, journal, etc)
  server.tool(
    'create_voucher',
    'create a voucher in tally. supports sales, purchase, payment, receipt, contra, journal and other types. each voucher needs ledger entries that balance (debits = credits).',
    {
      voucherTypeName: z.string().describe('type of voucher like Sales, Purchase, Payment, Receipt, Journal, Contra'),
      date: z.string().describe('voucher date in yyyy-mm-dd format'),
      partyLedgerName: z.string().describe('name of the party ledger (customer or supplier)'),
      ledgerEntries: z.array(z.object({
        ledgerName: z.string().describe('name of the ledger'),
        amount: z.number().describe('positive for debit, negative for credit'),
        billAllocations: z.array(z.object({
          name: z.string(),
          type: z.string().describe('new ref or against ref'),
          amount: z.number(),
        })).optional(),
      })).describe('ledger entries that must balance to zero'),
      inventoryEntries: z.array(z.object({
        stockItemName: z.string(),
        quantity: z.number(),
        rate: z.number(),
        amount: z.number(),
        godownName: z.string().optional(),
        batchAllocations: z.array(z.object({
          godownName: z.string(),
          batchName: z.string().optional(),
          quantity: z.number(),
          amount: z.number(),
        })).optional(),
      })).optional().describe('stock item entries for purchase/sales with inventory'),
      narration: z.string().optional().describe('notes or description for the voucher'),
      voucherNumber: z.string().optional(),
      isInvoice: z.boolean().optional().describe('true for tax invoices'),
      company: z.string().optional(),
    },
    async (params) => {
      const result = await bridge.createVoucher(params as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // create a ledger account
  server.tool(
    'create_ledger',
    'create a new ledger account in tally. ledgers are the basic accounts like bank accounts, party accounts, expense heads, tax ledgers etc.',
    {
      name: z.string().describe('ledger name'),
      parent: z.string().optional().describe('parent group like Sundry Creditors, Sundry Debtors, Bank Accounts, etc'),
      openingBalance: z.number().optional().describe('opening balance amount'),
      gstin: z.string().optional().describe('gst identification number'),
      state: z.string().optional().describe('state name for gst'),
      country: z.string().optional().describe('country name'),
      address: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      pincode: z.string().optional(),
      panNumber: z.string().optional(),
      gstRegistrationType: z.string().optional().describe('regular, composition, consumer, unregistered'),
      company: z.string().optional(),
    },
    async (params) => {
      const result = await bridge.createLedger(params as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // create a stock item
  server.tool(
    'create_stock_item',
    'create a new stock/inventory item in tally with optional gst and hsn details',
    {
      name: z.string().describe('stock item name'),
      parent: z.string().optional().describe('parent stock group'),
      baseUnit: z.string().optional().describe('unit of measure like Nos, Kg, Pcs'),
      openingBalance: z.number().optional(),
      openingRate: z.number().optional(),
      openingValue: z.number().optional(),
      hsnCode: z.string().optional().describe('hsn/sac code for gst'),
      gstRate: z.number().optional().describe('gst rate percentage'),
      company: z.string().optional(),
    },
    async (params) => {
      const result = await bridge.createStockItem(params as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // create a stock group
  server.tool(
    'create_stock_group',
    'create a new stock group to organize inventory items',
    {
      name: z.string().describe('stock group name'),
      parent: z.string().optional().describe('parent stock group, defaults to Primary'),
      company: z.string().optional(),
    },
    async (params) => {
      const result = await bridge.createStockGroup(params as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // create a measurement unit
  server.tool(
    'create_unit',
    'create a new unit of measure in tally like Nos, Kg, Pcs, Box',
    {
      name: z.string().describe('unit symbol like Nos, Kg, Pcs'),
      company: z.string().optional(),
    },
    async (params) => {
      const result = await bridge.createUnit(params as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
