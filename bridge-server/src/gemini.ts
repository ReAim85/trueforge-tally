// Dynamically import @google/genai to support CommonJS and ESM environments.
async function createGenAIClient(apiKey: string) {
  const mod = await import('@google/genai');
  return new mod.GoogleGenAI({ apiKey });
}

export interface BillAllocationPayload {
  name: string;
  billType?: 'New Ref' | 'Agst Ref' | 'Advance' | 'On Account';
  amount: number;
}

export interface LedgerEntryPayload {
  ledgerName: string;
  amount: number;
  isDeemedPositive?: boolean;
  billAllocations?: BillAllocationPayload[];
}

export interface AccountingAllocation {
  ledgerName: string;
  amount: number;
  isDeemedPositive?: boolean;
}

export interface BatchAllocationPayload {
  godownName: string;
  amount: number;
  actualQuantity?: number;
  billedQuantity?: number;
}

export interface InventoryEntryPayload {
  stockItemName: string;
  quantity: number;
  rate: number;
  unit?: string;
  amount: number;
  isDeemedPositive?: boolean;
  accountingAllocations?: AccountingAllocation[];
  batchAllocations?: BatchAllocationPayload[];
}

export interface VoucherPayload {
  voucherTypeName: string;
  date: string; // YYYY-MM-DD
  voucherNumber: string;
  reference?: string;
  partyLedgerName: string;
  partyGstin?: string;
  placeOfSupply?: string;
  isInvoice?: boolean;
  narration?: string;
  company?: string;
  ledgerEntries: LedgerEntryPayload[];
  inventoryEntries?: InventoryEntryPayload[];
  [key: string]: unknown;
}

export interface ExtractedLineItem {
  name: string;
  quantity: number;
  unitPrice: number;
  unit?: string;
  hsnCode?: string;
  gstRate?: number;
  taxAmount?: number;
  amount?: number;
  description?: string;
}

export interface ExtractedTaxEntry {
  ledgerName: string; // "CGST", "SGST", "IGST"
  rate?: number;
  amount: number;
}

export interface ExtractedVendor {
  name: string;
  gstin?: string;
  address?: string;
  state?: string;
  pincode?: string;
  email?: string;
  phone?: string;
}

export interface ExtractedBillDetails {
  billNumber: string;
  date: string; // YYYY-MM-DD
  dueDate?: string;
  placeOfSupply?: string;
  reference?: string;
  narration?: string;
}

export interface ExtractedBillData {
  vendor: ExtractedVendor;
  bill: ExtractedBillDetails;
  lineItems: ExtractedLineItem[];
  taxes?: ExtractedTaxEntry[];
  subtotal?: number;
  roundOff?: number;
  extractedTotal: number;
  rawJson?: unknown;
}

export interface ExtractBillOptions {
  apiKey?: string;
  model?: string;
  mimeType?: string;
  company?: string;
  defaultVoucherType?: string;
}

// Temporary hardcode: every bill gets this date regardless of the printed/OCR'd
// date. Swap the two usages below back to the extracted date once no longer needed.
const DEFAULT_BILL_DATE = '2026-08-01';

const EXTRACTION_SYSTEM_PROMPT = `You are an expert Indian accounting AI specialized in invoice/bill data extraction for TallyPrime ERP.
Analyze the attached invoice/bill document (image/PDF) and extract all details into a clean, strictly formatted JSON object.

### Output JSON Schema:
{
  "vendor": {
    "name": "Vendor / Supplier Company Name",
    "gstin": "15-character GSTIN (if present)",
    "address": "Supplier Address",
    "state": "Supplier State (e.g. Maharashtra)",
    "pincode": "Postal / PIN code (e.g. 400001)",
    "email": "vendor email (if present)",
    "phone": "vendor phone (if present)"
  },
  "bill": {
    "billNumber": "Invoice / Bill / Reference Number",
    "date": "2026-08-01", //do not change this date in any bill no matter what.
    "dueDate": "YYYY-MM-DD (if present)",
    "placeOfSupply": "State of supply (e.g. Maharashtra)",
    "reference": "Supplier reference number",
    "narration": "Brief narration summary"
  },
  "lineItems": [
    {
      "name": "Exact Stock Item / Description",
      "quantity": 10,
      "unitPrice": 500.00,
      "unit": "NOS",
      "hsnCode": "84713010",
      "gstRate": 18,
      "taxAmount": 900.00,
      "amount": 5000.00
    }
  ],
  "taxes": [
    { "ledgerName": "CGST", "rate": 9, "amount": 450.00 },
    { "ledgerName": "SGST", "rate": 9, "amount": 450.00 }
  ],
  "subtotal": 5000.00,
  "roundOff": 0.00,
  "extractedTotal": 5900.00
}

### Strict Extraction Guidelines:
1. Output ONLY valid, raw JSON. Do NOT wrap in markdown backticks or commentary.
2. "vendor.name": The seller / supplier who issued the bill.
3. "bill.billNumber": The invoice / bill number.
4. "bill.date": Always set the bill date to "2026-08-01" for every bill, ignoring any printed date. Strictly formatted as "YYYY-MM-DD".
5. "lineItems": Extract EVERY line item with name, quantity, unit price (rate), unit (e.g. "NOS", "PCS", "KGS", "BOX"), HSN code, GST rate, and amount (quantity * unitPrice).
6. "taxes": Identify CGST, SGST, IGST, Cess amounts. For intra-state, split tax into CGST and SGST. For inter-state, use IGST.
7. "extractedTotal": The final grand total / net payable amount printed on the invoice.
8. If there is a rounding difference (+/- fractional rupees), capture it in "roundOff".
`;

/**
 * Normalizes an invoice date string into strict ISO YYYY-MM-DD.
 */
export function normalizeInvoiceDate(rawDate?: string): string {
  if (!rawDate) return new Date().toISOString().slice(0, 10);
  const trimmed = rawDate.trim();

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY
  const dmyMatch = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // YYYY/MM/DD or YYYY.MM.DD
  const ymdMatch = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (ymdMatch) {
    const [, y, m, d] = ymdMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // Fallback to Date.parse
  const parsed = Date.parse(trimmed);
  if (!isNaN(parsed)) {
    const d = new Date(parsed);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  return new Date().toISOString().slice(0, 10);
}

/**
 * Parses raw JSON output from Gemini into structured ExtractedBillData.
 */
export function parseExtractedJsonToBillData(raw: Record<string, unknown>): ExtractedBillData {
  // Check if structure matches nested schema or flat voucher schema
  let vendorName = '';
  let vendorGstin: string | undefined;
  let vendorAddress: string | undefined;
  let vendorState: string | undefined;
  let vendorPincode: string | undefined;
  let vendorEmail: string | undefined;
  let vendorPhone: string | undefined;

  let billNumber = '';
  let date = '';
  let dueDate: string | undefined;
  let placeOfSupply: string | undefined;
  let reference: string | undefined;
  let narration: string | undefined;

  const lineItems: ExtractedLineItem[] = [];
  const taxes: ExtractedTaxEntry[] = [];
  let roundOff: number | undefined;
  let extractedTotal = 0;
  let subtotal = 0;

  if (raw.vendor && typeof raw.vendor === 'object') {
    const v = raw.vendor as Record<string, unknown>;
    vendorName = String(v.name || '').trim();
    vendorGstin = v.gstin ? String(v.gstin).trim() : undefined;
    vendorAddress = v.address ? String(v.address).trim() : undefined;
    vendorState = v.state ? String(v.state).trim() : undefined;
    vendorPincode = v.pincode ? String(v.pincode).trim() : undefined;
    vendorEmail = v.email ? String(v.email).trim() : undefined;
    vendorPhone = v.phone ? String(v.phone).trim() : undefined;
  } else if (raw.partyLedgerName) {
    vendorName = String(raw.partyLedgerName).trim();
    vendorGstin = raw.partyGstin ? String(raw.partyGstin).trim() : undefined;
    vendorState = raw.placeOfSupply ? String(raw.placeOfSupply).trim() : undefined;
  }

  if (raw.bill && typeof raw.bill === 'object') {
    const b = raw.bill as Record<string, unknown>;
    billNumber = String(b.billNumber || b.reference || '').trim();
    date = normalizeInvoiceDate(b.date as string);
    dueDate = b.dueDate ? normalizeInvoiceDate(b.dueDate as string) : undefined;
    placeOfSupply = b.placeOfSupply ? String(b.placeOfSupply).trim() : undefined;
    reference = b.reference ? String(b.reference).trim() : billNumber;
    narration = b.narration ? String(b.narration).trim() : undefined;
  } else {
    billNumber = String(raw.voucherNumber || raw.reference || `BILL-${Date.now()}`).trim();
    date = normalizeInvoiceDate(raw.date as string);
    reference = String(raw.reference || billNumber).trim();
    placeOfSupply = raw.placeOfSupply ? String(raw.placeOfSupply).trim() : undefined;
    narration = raw.narration ? String(raw.narration).trim() : undefined;
  }

  // Parse line items
  const rawItems = Array.isArray(raw.lineItems)
    ? raw.lineItems
    : Array.isArray(raw.inventoryEntries)
      ? raw.inventoryEntries
      : [];

  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    const name = String(it.name || it.stockItemName || 'General Item').trim();
    const qty = Number(it.quantity) || 1;
    const unitPrice = Number(it.unitPrice ?? it.rate ?? 0);
    const amount = Number(it.amount) || Math.round(qty * unitPrice * 100) / 100;
    const unit = it.unit ? String(it.unit).trim() : 'NOS';
    const hsnCode = it.hsnCode ? String(it.hsnCode).trim() : undefined;
    const gstRate = it.gstRate !== undefined ? Number(it.gstRate) : undefined;
    const taxAmount = it.taxAmount !== undefined ? Number(it.taxAmount) : undefined;
    const description = it.description ? String(it.description).trim() : undefined;

    lineItems.push({
      name,
      quantity: qty,
      unitPrice,
      unit,
      hsnCode,
      gstRate,
      taxAmount,
      amount,
      description,
    });
  }

  // Parse taxes
  if (Array.isArray(raw.taxes)) {
    for (const t of raw.taxes) {
      if (!t || typeof t !== 'object') continue;
      const tx = t as Record<string, unknown>;
      const ledgerName = String(tx.ledgerName || tx.name || 'GST').trim();
      const amount = Math.abs(Number(tx.amount) || 0);
      const rate = tx.rate !== undefined ? Number(tx.rate) : undefined;
      taxes.push({ ledgerName, rate, amount });
    }
  } else if (Array.isArray(raw.ledgerEntries)) {
    for (const e of raw.ledgerEntries) {
      if (!e || typeof e !== 'object') continue;
      const le = e as Record<string, unknown>;
      const name = String(le.ledgerName || '').trim();
      const amt = Number(le.amount) || 0;
      if (name.toLowerCase() === 'round off' || name.toLowerCase() === 'roundoff') {
        roundOff = amt;
      } else if (
        ['cgst', 'sgst', 'igst', 'input cgst', 'input sgst', 'input igst', 'cess'].some((taxName) =>
          name.toLowerCase().includes(taxName),
        )
      ) {
        taxes.push({ ledgerName: name, amount: Math.abs(amt) });
      }
    }
  }

  if (raw.roundOff !== undefined) {
    roundOff = Number(raw.roundOff);
  }

  if (raw.subtotal !== undefined) {
    subtotal = Number(raw.subtotal);
  } else if (lineItems.length > 0) {
    subtotal = lineItems.reduce((sum, item) => sum + (item.amount || item.quantity * item.unitPrice), 0);
  }

  if (raw.extractedTotal !== undefined) {
    extractedTotal = Number(raw.extractedTotal);
  } else if (raw.total !== undefined) {
    extractedTotal = Number(raw.total);
  } else {
    // If party ledger entry exists with negative amount, that is the total
    const partyEntry = Array.isArray(raw.ledgerEntries)
      ? raw.ledgerEntries.find((e: Record<string, unknown>) => String(e.ledgerName || '').toLowerCase() === vendorName.toLowerCase())
      : null;
    if (partyEntry && partyEntry.amount) {
      extractedTotal = Math.abs(Number(partyEntry.amount));
    } else {
      const taxSum = taxes.reduce((s, t) => s + t.amount, 0);
      extractedTotal = Math.round((subtotal + taxSum + (roundOff || 0)) * 100) / 100;
    }
  }

  // Temporary hardcode — see DEFAULT_BILL_DATE above.
  date = DEFAULT_BILL_DATE;

  return {
    vendor: {
      name: vendorName,
      gstin: vendorGstin,
      address: vendorAddress,
      state: vendorState,
      pincode: vendorPincode,
      email: vendorEmail,
      phone: vendorPhone,
    },
    bill: {
      billNumber,
      date,
      dueDate,
      placeOfSupply,
      reference,
      narration,
    },
    lineItems,
    taxes: taxes.length > 0 ? taxes : undefined,
    subtotal,
    roundOff,
    extractedTotal,
    rawJson: raw,
  };
}

/**
 * A line item is a service (not stock) when its HSN is in the 99-series service
 * range, or — when no HSN was extracted — its name looks like a service/expense.
 * Service lines are posted to ledgers instead of being created as stock items.
 */
export function isServiceItem(item: ExtractedLineItem): boolean {
  const hsn = String(item.hsnCode || '').trim();
  if (hsn) return /^99/.test(hsn);
  const name = String(item.name || '').toLowerCase();
  return /(fee|service|charges|commission|rent|travel|transport|ride|freight|courier|subscription|maintenance|support|professional|consulting|insurance|repair)/.test(
    name,
  );
}

/**
 * Converts structured ExtractedBillData into a balanced Tally VoucherPayload.
 *
 * @param defaultGodown When given, each inventory entry gets a BATCHALLOCATIONS
 *   pointing at this godown. Tally silently drops stock entries that carry no
 *   godown/batch allocation and posts them as plain ledger lines instead, so a
 *   real godown name is required for the stock item names to reach the voucher.
 */
export function convertExtractedDataToVoucher(
  data: ExtractedBillData,
  company?: string,
  defaultGodown?: string,
): VoucherPayload {
  const voucherTypeName = 'Purchase';
  const voucherNumber = data.bill.billNumber || `BILL-${Date.now()}`;
  const reference = data.bill.reference || voucherNumber;
  const partyLedgerName = data.vendor.name || 'Sundry Creditors';
  // Temporary hardcode — see DEFAULT_BILL_DATE above.
  const date = DEFAULT_BILL_DATE;

  // Service lines (HSN 99xxxx, e.g. "Captain Fee" on a cab bill) are expenses,
  // not inventory — each becomes its own expense ledger entry (auto-created by
  // the workflow if missing) so the voucher shows the item name. Goods lines
  // become inventory entries as before.
  const goodsItems = data.lineItems.filter((item) => !isServiceItem(item));
  const serviceItems = data.lineItems.filter((item) => isServiceItem(item));

  const inventoryEntries: InventoryEntryPayload[] = goodsItems.map((item) => {
    const qty = item.quantity || 1;
    const rate = item.unitPrice || 0;
    const amount = item.amount || Math.round(qty * rate * 100) / 100;
    const unit = item.unit || 'NOS';
    const stockItemName = item.name;

    return {
      stockItemName,
      quantity: qty,
      rate,
      unit,
      amount,
      isDeemedPositive: true,
      accountingAllocations: [
        {
          ledgerName: 'Purchase Accounts',
          amount,
          isDeemedPositive: true,
        },
      ],
      batchAllocations: defaultGodown
        ? [{ godownName: defaultGodown, amount, actualQuantity: qty, billedQuantity: qty }]
        : undefined,
    };
  });

  const itemsTotal = inventoryEntries.reduce((sum, item) => sum + item.amount, 0);
  const servicesTotal = serviceItems.reduce(
    (sum, item) => sum + (item.amount ?? item.quantity * item.unitPrice),
    0,
  );
  const isInvoice = inventoryEntries.length > 0;
  const taxEntries: LedgerEntryPayload[] = (data.taxes || []).map((t) => ({
    ledgerName: t.ledgerName,
    amount: Math.abs(t.amount),
    isDeemedPositive: true,
  }));

  // Compute a balancing "Round Off" so the voucher always nets to the extracted
  // total. Many vendors don't print a round-off line, yet their item/tax amounts
  // still round to a slightly different total (e.g. 403.01 vs 403.00). Tally
  // rejects an unbalanced voucher, so the difference is added as a Round Off
  // ledger entry (credit when the items sum higher, debit when lower).
  const sumDebits = itemsTotal + servicesTotal + taxEntries.reduce((sum, t) => sum + t.amount, 0);
  const balancingRoundOff =
    data.extractedTotal > 0 ? Math.round((data.extractedTotal - sumDebits) * 100) / 100 : 0;

  const roundOffEntries: LedgerEntryPayload[] =
    Math.abs(balancingRoundOff) > 0.001
      ? [
          {
            ledgerName: 'Round Off',
            amount: balancingRoundOff,
            isDeemedPositive: balancingRoundOff > 0,
          },
        ]
      : [];

  const totalPayable =
    data.extractedTotal > 0
      ? data.extractedTotal
      : sumDebits + balancingRoundOff;

  const finalLedgerEntries: LedgerEntryPayload[] = [
    {
      ledgerName: partyLedgerName,
      amount: -Math.abs(totalPayable),
      isDeemedPositive: false,
      billAllocations: [
        {
          name: voucherNumber,
          billType: 'New Ref',
          amount: -Math.abs(totalPayable),
        },
      ],
    },
    ...taxEntries,
    ...roundOffEntries,
  ];

  // Service line items (HSN 99xxxx) are expenses — each becomes its own named
  // ledger entry (e.g. "Captain Fee"), auto-created by the workflow if missing,
  // so the voucher shows the actual item name instead of a generic account.
  for (const item of serviceItems) {
    const amount = item.amount ?? item.quantity * item.unitPrice;
    if (amount <= 0) continue; // skip zero-value lines like "Convenience Charges"
    finalLedgerEntries.push({
      ledgerName: item.name.trim(),
      amount,
      isDeemedPositive: true,
    });
  }

  // Bill with no line items at all — debit the subtotal.
  if (inventoryEntries.length === 0 && itemsTotal === 0 && servicesTotal === 0 && (data.subtotal || 0) > 0) {
    finalLedgerEntries.push({
      ledgerName: 'Purchase Accounts',
      amount: data.subtotal || totalPayable,
      isDeemedPositive: true,
    });
  }

  return {
    voucherTypeName,
    date,
    voucherNumber,
    reference,
    partyLedgerName,
    partyGstin: data.vendor.gstin,
    placeOfSupply: data.bill.placeOfSupply || data.vendor.state,
    isInvoice,
    narration: data.bill.narration || `Being purchase vide bill no ${voucherNumber}`,
    company,
    ledgerEntries: finalLedgerEntries,
    inventoryEntries: inventoryEntries.length ? inventoryEntries : undefined,
  };
}

/**
 * Normalizes and balances an extracted voucher payload (backward compatibility helper).
 */
export function normalizeExtractedVoucher(
  raw: Partial<VoucherPayload> | Record<string, unknown>,
  company?: string,
): VoucherPayload {
  const structured = parseExtractedJsonToBillData(raw as Record<string, unknown>);
  return convertExtractedDataToVoucher(structured, company);
}

/**
 * Extracts structured invoice data from an image or PDF using Google Gemini.
 */
export async function extractBillDataFromImage(
  imageInput: string | Buffer,
  opts: ExtractBillOptions = {},
): Promise<ExtractedBillData> {
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set. Please set the GEMINI_API_KEY environment variable.');
  }

  let mimeType = opts.mimeType || 'image/jpeg';
  let base64Data: string;

  if (Buffer.isBuffer(imageInput)) {
    base64Data = imageInput.toString('base64');
  } else if (typeof imageInput === 'string') {
    const dataUrlMatch = imageInput.match(/^data:([^;]+);base64,(.+)$/);
    if (dataUrlMatch) {
      mimeType = dataUrlMatch[1];
      base64Data = dataUrlMatch[2];
    } else {
      base64Data = imageInput.trim();
    }
  } else {
    throw new Error('Invalid image input: expected base64 string or Buffer');
  }

  const modelName = opts.model || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const ai = await createGenAIClient(apiKey);

  const prompt = `${EXTRACTION_SYSTEM_PROMPT}\n${
    opts.defaultVoucherType ? `Default Voucher Type: ${opts.defaultVoucherType}` : ''
  }`;

  const response = await ai.models.generateContent({
    model: modelName,
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64Data,
            },
          },
          {
            text: prompt,
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
    },
  });

  const responseText = response.text?.trim() || '';
  if (!responseText) {
    throw new Error('Empty response received from Gemini model');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch (err) {
    const cleanJson = responseText.replace(/^```json\s*|\s*```$/g, '').trim();
    parsed = JSON.parse(cleanJson);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Gemini did not return a valid JSON object');
  }

  return parseExtractedJsonToBillData(parsed as Record<string, unknown>);
}

/**
 * Extracts invoice voucher details from an image or PDF using Google Gemini (VoucherPayload format).
 */
export async function extractBillFromImage(
  imageInput: string | Buffer,
  opts: ExtractBillOptions = {},
): Promise<VoucherPayload> {
  const billData = await extractBillDataFromImage(imageInput, opts);
  return convertExtractedDataToVoucher(billData, opts.company);
}
