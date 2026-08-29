// ai powered tools for bill processing using gemini ocr

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BridgeClient } from '../bridge-client.js';

export function registerAiTools(server: McpServer, bridge: BridgeClient): void {

  // extract bill data from an image without posting to tally
  server.tool(
    'extract_bill',
    'extract structured invoice/bill data from an image using ocr. returns vendor info, line items, taxes, and totals. does not write anything to tally.',
    {
      image: z.string().describe('base64 encoded image or data url of the bill/invoice'),
      mimeType: z.string().optional().describe('image mime type like image/jpeg, image/png, application/pdf'),
      company: z.string().optional(),
    },
    async (params) => {
      const result = await bridge.extractBill(params.image, {
        mimeType: params.mimeType,
        company: params.company,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // full 7 step bill processing workflow
  server.tool(
    'process_bill',
    'process a purchase bill end to end: ocr extract, validate fields, lookup or create vendor ledger, lookup or create stock items, verify math, and post the purchase voucher to tally. this writes data to tally.',
    {
      image: z.string().describe('base64 encoded image or data url of the bill/invoice'),
      mimeType: z.string().optional().describe('image mime type'),
      company: z.string().optional(),
      autoPost: z.boolean().optional().describe('whether to auto post the voucher, defaults to true'),
      tolerance: z.number().optional().describe('allowed difference between calculated and extracted total, defaults to 1.0'),
    },
    async (params) => {
      const result = await bridge.processBill(params.image, {
        mimeType: params.mimeType,
        company: params.company,
        autoPost: params.autoPost,
        tolerance: params.tolerance,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
