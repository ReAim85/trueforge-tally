// ai powered tools for bill processing using gemini ocr

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BridgeClient } from '../bridge-client.js';

const PROXY_URL = process.env.CEREBRAS_PROXY_URL || 'http://localhost:9100';

export function registerAiTools(server: McpServer, bridge: BridgeClient): void {

  // fetch the latest uploaded image/pdf captured by the proxy for a given session
  server.tool(
    'get_uploaded_file',
    'get the latest file (image or pdf) that the user uploaded in the chat. the cerebras proxy captures inline files automatically. use this before calling extract_bill or process_bill to get the base64 data you need. requires the session id that identifies the current chat session.',
    {
      sessionId: z.string().describe('the session id for the current chat session. this scopes the file lookup to the correct user.'),
    },
    async (params) => {
      try {
        const resp = await fetch(`${PROXY_URL}/latest-image`, {
          headers: { 'x-session-id': params.sessionId },
        });
        if (!resp.ok) {
          return {
            content: [{ type: 'text' as const, text: 'no file has been uploaded for this session. ask the user to upload a bill image or pdf.' }],
          };
        }
        const data = await resp.json() as { id: string; base64: string; mimeType: string };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            id: data.id,
            mimeType: data.mimeType,
            base64Length: data.base64.length,
            base64: data.base64,
          }) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `failed to reach proxy at ${PROXY_URL}: ${(err as Error).message}` }],
        };
      }
    },
  );

  // extract bill data from an image without posting to tally
  server.tool(
    'extract_bill',
    'extract structured invoice/bill data from an image using ocr. returns vendor info, line items, taxes, and totals. does not write anything to tally. tip: if the user uploaded a file in chat, call get_uploaded_file first to get the base64 data.',
    {
      image: z.string().describe('the actual base64 encoded image data (not a file path). call get_uploaded_file first to get this data from an uploaded file.'),
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
      image: z.string().describe('the actual base64 encoded image data (not a file path). call get_uploaded_file first to get this data from an uploaded file.'),
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
