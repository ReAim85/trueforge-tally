import fs from 'node:fs';
import path from 'node:path';
import {
  convertExtractedDataToVoucher,
  extractBillDataFromImage,
  isServiceItem,
  type ExtractedBillData,
  type ExtractedLineItem,
  type VoucherPayload,
} from './gemini';

export interface AgentGateway {
  fetch(entity: string, opts?: { company?: string }): Promise<Record<string, unknown>[]>;
  postLedger(ledger: Record<string, unknown>, company?: string): Promise<{ status: string; masterId?: number; error?: string }>;
  postStockItem(stockItem: Record<string, unknown>, company?: string): Promise<{ status: string; masterId?: number; error?: string }>;
  postStockGroup(stockGroup: Record<string, unknown>, company?: string): Promise<{ status: string; masterId?: number; error?: string }>;
  postUnit(unit: Record<string, unknown>, company?: string): Promise<{ status: string; masterId?: number; error?: string }>;
  postVoucher(voucher: VoucherPayload, company?: string): Promise<{ status: string; voucherId?: number; error?: string }>;
}

export interface BillWorkflowOptions {
  company?: string;
  autoPost?: boolean;
  dryRun?: boolean;
  tolerance?: number; // default 1.00 rupee
  geminiApiKey?: string;
  geminiModel?: string;
  mimeType?: string;
  logger?: (msg: string) => void;
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: string[];
}

export interface WorkflowItemStatus {
  name: string;
  created: boolean;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface BillWorkflowResult {
  ok: boolean;
  status: 'created' | 'verified' | 'validation_error' | 'master_creation_error' | 'review_required' | 'tally_error';
  reason?: string;
  error?: string;
  calculatedTotal?: number;
  extractedTotal?: number;
  difference?: number;
  tolerance?: number;
  voucherId?: number;
  voucherNumber?: string;
  vendor?: {
    name: string;
    created: boolean;
  };
  items?: WorkflowItemStatus[];
  extractedBill?: ExtractedBillData;
  tallyResult?: Record<string, unknown>;
  logs?: string[];
}

/**
 * Validates mandatory fields required by Tally for a purchase bill.
 */
export function validateExtractedBill(bill: ExtractedBillData): WorkflowValidationResult {
  const errors: string[] = [];

  // Vendor validation
  if (!bill.vendor?.name || !bill.vendor.name.trim()) {
    errors.push('Missing mandatory field: vendor name');
  }

  // Bill number / reference
  if (!bill.bill?.billNumber || !bill.bill.billNumber.trim()) {
    errors.push('Missing mandatory field: bill number / invoice reference');
  }

  // Date
  if (!bill.bill?.date || !/^\d{4}-\d{2}-\d{2}$/.test(bill.bill.date.trim())) {
    errors.push('Missing or invalid mandatory field: date (must be YYYY-MM-DD)');
  }

  // Line items
  if (!Array.isArray(bill.lineItems) || bill.lineItems.length === 0) {
    errors.push('Bill must contain at least one line item');
  } else {
    for (let i = 0; i < bill.lineItems.length; i++) {
      const item = bill.lineItems[i];
      if (!item.name || !item.name.trim()) {
        errors.push(`Line item #${i + 1} is missing item name`);
      }
      if (typeof item.quantity !== 'number' || isNaN(item.quantity) || item.quantity <= 0) {
        errors.push(`Line item #${i + 1} (${item.name || 'unnamed'}) has invalid quantity: ${item.quantity}`);
      }
      if (typeof item.unitPrice !== 'number' || isNaN(item.unitPrice) || item.unitPrice < 0) {
        errors.push(`Line item #${i + 1} (${item.name || 'unnamed'}) has invalid unit price: ${item.unitPrice}`);
      }
    }
  }

  // Extracted total
  if (typeof bill.extractedTotal !== 'number' || isNaN(bill.extractedTotal) || bill.extractedTotal <= 0) {
    errors.push(`Invalid extracted total amount: ${bill.extractedTotal}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Collects the unique ledgers a voucher references (party, ledger entries, and
 * inventory accounting allocations) so they can be verified before posting.
 */
function collectVoucherLedgerNames(voucher: VoucherPayload): string[] {
  const names = new Set<string>();
  if (voucher.partyLedgerName) names.add(voucher.partyLedgerName.trim());
  for (const entry of voucher.ledgerEntries ?? []) {
    if (entry.ledgerName) names.add(entry.ledgerName.trim());
  }
  for (const inv of voucher.inventoryEntries ?? []) {
    for (const alloc of inv.accountingAllocations ?? []) {
      if (alloc.ledgerName) names.add(alloc.ledgerName.trim());
    }
  }
  return [...names];
}

/**
 * Picks a sensible Tally group to create a missing ledger under, derived from the
 * ledger's name: input GST under Current Assets, output tax under Current
 * Liabilities, purchase ledgers under Purchase Accounts, and everything else
 * (expenses like "Conveyance Expense", "Round Off", ...) under Indirect Expenses.
 */
function parentGroupForLedger(name: string): string {
  const n = name.trim().toLowerCase();
  if (n.includes('input') && /(cgst|sgst|igst|cess|gst|tax)/.test(n)) return 'Current Assets';
  if (/(output|cgst|sgst|igst|cess|gst|vat|tds|tax)/.test(n)) return 'Current Liabilities';
  if (n.includes('round off') || n === 'roundoff') return 'Indirect Expenses';
  if (n.includes('purchase')) return 'Purchase Accounts';
  return 'Indirect Expenses';
}

function ledgerPayloadForVoucherReference(ledgerName: string): Record<string, unknown> {
  const parent = parentGroupForLedger(ledgerName);
  const isPurchaseLedger = parent === 'Purchase Accounts';
  return {
    name: ledgerName,
    parent,
    ...(isPurchaseLedger ? { isInventoryAffected: true } : {}),
  };
}

/**
 * Executes the complete server-orchestrated 7-step bill processing workflow.
 */
export async function executeBillWorkflow(
  imageInput: string | Buffer | ExtractedBillData,
  gateway: AgentGateway,
  opts: BillWorkflowOptions = {},
): Promise<BillWorkflowResult> {
  const workflowLogs: string[] = [];

  // Persist each run's logs to a logs/ directory (default: repo-root/logs, override with LOG_DIR).
  const logsDir = process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs');
  let runLogFile = '';
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    runLogFile = path.join(logsDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  } catch {
    runLogFile = '';
  }

  const log = (msg: string) => {
    const timestamp = new Date().toISOString().slice(11, 23);
    const formatted = `[${timestamp}] [BillWorkflow] ${msg}`;
    workflowLogs.push(formatted);
    if (runLogFile) {
      try {
        fs.appendFileSync(runLogFile, formatted + '\n');
      } catch {
        /* logging to disk must never break the workflow */
      }
    }
    if (opts.logger) opts.logger(formatted);
    else console.log(formatted);
  };

  const tolerance = opts.tolerance ?? 1.0;
  const company = opts.company;
  const autoPost = opts.autoPost !== false && opts.dryRun !== true;

  log('Starting end-to-end bill processing workflow...');

  // -------------------------------------------------------------------------
  // Step 1: Extract JSON from Bill using OCR
  // -------------------------------------------------------------------------
  let billData: ExtractedBillData;

  if (
    typeof imageInput === 'object' &&
    imageInput !== null &&
    !Buffer.isBuffer(imageInput) &&
    'vendor' in imageInput &&
    'bill' in imageInput
  ) {
    log('[Step 1/7: OCR Extraction] Using pre-extracted bill data payload.');
    billData = imageInput as ExtractedBillData;
  } else {
    log('[Step 1/7: OCR Extraction] Extracting structured data from bill image/PDF via Gemini OCR...');
    try {
      billData = await extractBillDataFromImage(imageInput as string | Buffer, {
        apiKey: opts.geminiApiKey,
        model: opts.geminiModel,
        mimeType: opts.mimeType,
        company,
      });
      log(
        `[Step 1/7: OCR Extraction] Extracted bill successfully: Vendor="${billData.vendor.name}", BillNo="${billData.bill.billNumber}", Date="${billData.bill.date}", Items=${billData.lineItems.length}, Total=${billData.extractedTotal}`,
      );
      log(
        `[Step 1/7: OCR Extraction] Line items (name | qty | unitPrice | amount | hsn | gst%):` +
          billData.lineItems
            .map(
              (it) =>
                `\n  - ${it.name} | qty=${it.quantity} | unitPrice=${it.unitPrice} | amount=${
                  it.amount ?? Math.round(it.quantity * it.unitPrice * 100) / 100
                } | hsn=${it.hsnCode ?? '-'} | gst=${it.gstRate ?? '-'}`,
            )
            .join(''),
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`[Step 1/7: OCR Extraction] OCR extraction failed: ${error}`);
      return {
        ok: false,
        status: 'validation_error',
        error: `OCR extraction failed: ${error}`,
        logs: workflowLogs,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Validate Required Fields
  // -------------------------------------------------------------------------
  log('[Step 2/7: Validation] Validating mandatory bill fields for Tally voucher...');
  const validation = validateExtractedBill(billData);
  if (!validation.valid) {
    const errMsg = validation.errors.join('; ');
    log(`[Step 2/7: Validation] Validation failed: ${errMsg}`);
    return {
      ok: false,
      status: 'validation_error',
      error: errMsg,
      extractedBill: billData,
      logs: workflowLogs,
    };
  }
  log('[Step 2/7: Validation] Mandatory fields validated successfully.');

  // -------------------------------------------------------------------------
  // Step 3: Search for Vendor in Database (Tally)
  // -------------------------------------------------------------------------
  log(`[Step 3/7: Vendor Lookup] Checking if vendor "${billData.vendor.name}" exists in Tally...`);
  let vendorCreated = false;

  try {
    const ledgers = await gateway.fetch('ledgers', { company });
    const vendorLower = billData.vendor.name.trim().toLowerCase();
    const existingLedger = ledgers.find((l) => {
      const name = String(l.NAME || l.name || '').trim().toLowerCase();
      return name === vendorLower;
    });

    if (existingLedger) {
      log(`[Step 3/7: Vendor Lookup] Vendor "${billData.vendor.name}" found in Tally.`);
    } else {
      log(`[Step 3/7: Vendor Lookup] Vendor "${billData.vendor.name}" not found. Creating new ledger under "Sundry Creditors"...`);
      const createRes = await gateway.postLedger(
        {
          name: billData.vendor.name,
          parent: 'Sundry Creditors',
          gstin: billData.vendor.gstin,
          partyGstin: billData.vendor.gstin,
          gstRegistrationType: billData.vendor.gstin ? 'Regular' : 'Unregistered',
          state: billData.vendor.state,
          address: billData.vendor.address,
          pincode: billData.vendor.pincode,
          email: billData.vendor.email,
          phone: billData.vendor.phone,
        },
        company,
      );

      if (createRes.status === 'error') {
        log(`[Step 3/7: Vendor Lookup] Failed to create vendor ledger in Tally: ${createRes.error}`);
        return {
          ok: false,
          status: 'master_creation_error',
          error: `Failed to create vendor ledger in Tally: ${createRes.error}`,
          extractedBill: billData,
          logs: workflowLogs,
        };
      }

      vendorCreated = true;
      log(`[Step 3/7: Vendor Lookup] Vendor ledger "${billData.vendor.name}" created successfully in Tally.`);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`[Step 3/7: Vendor Lookup] Vendor lookup failed: ${error}`);
    return {
      ok: false,
      status: 'tally_error',
      error: `Vendor lookup failed: ${error}`,
      extractedBill: billData,
      logs: workflowLogs,
    };
  }

  // -------------------------------------------------------------------------
  // Step 4: Search for Each Item by Name in Database (Tally)
  // -------------------------------------------------------------------------
  log(`[Step 4/7: Stock Item Lookup] Checking ${billData.lineItems.length} line items in Tally...`);
  const itemsReport: WorkflowItemStatus[] = [];

  // Service lines (HSN 99xxxx) are expenses, not inventory — they are posted as
  // ledger entries and must NOT be created as stock items.
  const goodsItems = billData.lineItems.filter((item) => !isServiceItem(item));
  const serviceItems = billData.lineItems.filter((item) => isServiceItem(item));

  if (serviceItems.length > 0) {
    log(
      `[Step 4/7: Stock Item Lookup] ${serviceItems.length} service line item(s) (e.g. "${serviceItems[0].name}") skipped — will post to ledgers instead of creating stock items.`,
    );
  }

  try {
    if (goodsItems.length > 0) {
      const stockItems = await gateway.fetch('stockitems', { company });
      const existingItemNames = new Set(
        stockItems.map((s) => String(s.NAME || s.name || '').trim().toLowerCase()),
      );

      // The default "Primary" stock group may not exist in every company (e.g.
      // service businesses). Create it first so the stock items have a home.
      const stockGroups = await gateway.fetch('stockgroups', { company });
      log(
        `[Step 4/7: Stock Item Lookup] [DIAG] Stock groups in Tally: ${
          stockGroups.map((g) => String(g.NAME || g.name || '')).join(', ') || '(none)'
        }`,
      );
      const primaryExists = stockGroups.some(
        (g) => String(g.NAME || g.name || '').trim().toLowerCase() === 'primary',
      );
      if (!primaryExists) {
        log('[Step 4/7: Stock Item Lookup] Stock Group "Primary" not found. Creating it...');
        const groupRes = await gateway.postStockGroup({ name: 'Primary' }, company);
        if (groupRes.status === 'error') {
          log(`[Step 4/7: Stock Item Lookup] Failed to create Stock Group "Primary": ${groupRes.error}`);
          return {
            ok: false,
            status: 'master_creation_error',
            error: `Failed to create Stock Group "Primary": ${groupRes.error}`,
            extractedBill: billData,
            logs: workflowLogs,
          };
        }
        log('[Step 4/7: Stock Item Lookup] Stock Group "Primary" created successfully in Tally.');
      }

      // Stock items reference a base unit (default "NOS"); the unit must exist
      // in Tally before the item can be created.
      const unitsNeeded = new Set(goodsItems.map((i) => (i.unit || 'NOS').trim()));
      const existingUnits = await gateway.fetch('units', { company });
      log(
        `[Step 4/7: Stock Item Lookup] [DIAG] Units in Tally: ${
          existingUnits.map((u) => String(u.NAME || u.name || '')).join(', ') || '(none)'
        }`,
      );
      const existingUnitNames = new Set(
        existingUnits.map((u) => String(u.NAME || u.name || '').trim().toLowerCase()),
      );
      for (const unitName of unitsNeeded) {
        if (existingUnitNames.has(unitName.toLowerCase())) continue;
        log(`[Step 4/7: Stock Item Lookup] Unit "${unitName}" not found. Creating it...`);
        const unitRes = await gateway.postUnit({ name: unitName }, company);
        if (unitRes.status === 'error') {
          log(`[Step 4/7: Stock Item Lookup] Failed to create Unit "${unitName}": ${unitRes.error}`);
          return {
            ok: false,
            status: 'master_creation_error',
            error: `Failed to create Unit "${unitName}": ${unitRes.error}`,
            extractedBill: billData,
            logs: workflowLogs,
          };
        }
        existingUnitNames.add(unitName.toLowerCase());
        log(`[Step 4/7: Stock Item Lookup] Unit "${unitName}" created successfully in Tally.`);
      }

      for (const item of goodsItems) {
        const itemLower = item.name.trim().toLowerCase();
        let created = false;

        if (existingItemNames.has(itemLower)) {
          log(`[Step 4/7: Stock Item Lookup] Stock item "${item.name}" found in Tally.`);
        } else {
          log(`[Step 4/7: Stock Item Lookup] Stock item "${item.name}" not found. Creating in Tally under "Primary"...`);
          const itemRes = await gateway.postStockItem(
            {
              name: item.name,
              parent: 'Primary',
              baseUnit: item.unit || 'NOS',
              hsnCode: item.hsnCode,
              gstRate: item.gstRate,
              description: item.description,
            },
            company,
          );

          if (itemRes.status === 'error') {
            log(`[Step 4/7: Stock Item Lookup] Failed to create stock item "${item.name}": ${itemRes.error}`);
            return {
              ok: false,
              status: 'master_creation_error',
              error: `Failed to create stock item "${item.name}": ${itemRes.error}`,
              extractedBill: billData,
              logs: workflowLogs,
            };
          }

          created = true;
          existingItemNames.add(itemLower);
          log(`[Step 4/7: Stock Item Lookup] Stock item "${item.name}" created successfully in Tally.`);
        }

        itemsReport.push({
          name: item.name,
          created,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          amount: item.amount || Math.round(item.quantity * item.unitPrice * 100) / 100,
        });
      }
    }

    // Service lines go straight into the report as not-created (no stock master).
    for (const item of serviceItems) {
      itemsReport.push({
        name: item.name,
        created: false,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.amount || Math.round(item.quantity * item.unitPrice * 100) / 100,
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`[Step 4/7: Stock Item Lookup] Stock items lookup failed: ${error}`);
    return {
      ok: false,
      status: 'tally_error',
      error: `Stock items lookup failed: ${error}`,
      extractedBill: billData,
      logs: workflowLogs,
    };
  }

  // -------------------------------------------------------------------------
  // Step 5: Calculate Total Manually from Extracted Line Items
  // -------------------------------------------------------------------------
  log('[Step 5/7: Math Calculation] Calculating subtotal, taxes, and net payable total from line items...');
  log(
    `[Step 5/7: Math Calculation] Line subtotals:` +
      billData.lineItems
        .map(
          (it) =>
            `\n  - ${it.name} | qty=${it.quantity} x rate=${it.unitPrice} = ${
              (it.amount ?? Math.round(it.quantity * it.unitPrice * 100) / 100).toFixed(2)
            }`,
        )
        .join('') +
      (billData.taxes?.length ? `\n  Taxes: ${billData.taxes.map((t) => `${t.ledgerName}=${t.amount}`).join(', ')}` : ''),
  );
  const calculatedSubtotal = billData.lineItems.reduce((sum, item) => {
    const lineAmt = item.amount !== undefined ? item.amount : item.quantity * item.unitPrice;
    return sum + lineAmt;
  }, 0);

  let calculatedTax = 0;
  if (billData.taxes && billData.taxes.length > 0) {
    calculatedTax = billData.taxes.reduce((sum, t) => sum + t.amount, 0);
  } else {
    // If explicit tax lines absent, sum taxAmount from items if present
    calculatedTax = billData.lineItems.reduce((sum, item) => sum + (item.taxAmount || 0), 0);
  }

  const roundOff = billData.roundOff || 0;
  const calculatedTotal = Math.round((calculatedSubtotal + calculatedTax + roundOff) * 100) / 100;

  log(
    `[Step 5/7: Math Calculation] Calculated Subtotal=${calculatedSubtotal.toFixed(2)}, Tax=${calculatedTax.toFixed(2)}, RoundOff=${roundOff.toFixed(2)} => Calculated Total=${calculatedTotal.toFixed(2)}`,
  );

  // -------------------------------------------------------------------------
  // Step 6: Compare Calculated Total with Extracted Total from Bill
  // -------------------------------------------------------------------------
  log(
    `[Step 6/7: Math Verification] Comparing Calculated Total (${calculatedTotal.toFixed(2)}) with Extracted Total (${billData.extractedTotal.toFixed(2)})...`,
  );
  const diff = Math.round(Math.abs(calculatedTotal - billData.extractedTotal) * 100) / 100;

  if (diff > tolerance) {
    log(
      `[Step 6/7: Math Verification] MISMATCH DETECTED! Difference=${diff.toFixed(2)} exceeds tolerance=${tolerance.toFixed(2)}. Flagging bill for review.`,
    );
    return {
      ok: false,
      status: 'review_required',
      reason: `Total mismatch: calculated total (${calculatedTotal.toFixed(2)}) does not match extracted bill total (${billData.extractedTotal.toFixed(2)})`,
      calculatedTotal,
      extractedTotal: billData.extractedTotal,
      difference: diff,
      tolerance,
      extractedBill: billData,
      items: itemsReport,
      logs: workflowLogs,
    };
  }

  log(`[Step 6/7: Math Verification] Totals match (difference ${diff.toFixed(2)} <= tolerance ${tolerance.toFixed(2)}).`);

  // -------------------------------------------------------------------------
  // Step 7: Create Bill Record / Voucher in Tally
  // -------------------------------------------------------------------------
  if (!autoPost) {
    log('[Step 7/7: Voucher Posting] Dry run requested (autoPost=false). Skipping voucher creation in Tally.');
    return {
      ok: true,
      status: 'verified',
      calculatedTotal,
      extractedTotal: billData.extractedTotal,
      vendor: { name: billData.vendor.name, created: vendorCreated },
      items: itemsReport,
      extractedBill: billData,
      logs: workflowLogs,
    };
  }

  log(`[Step 7/7: Voucher Posting] Posting Purchase Voucher for Bill "${billData.bill.billNumber}" to Tally...`);

  // Tally drops inventory entries that carry no godown/batch allocation and
  // silently turns them into plain "Purchase Accounts" ledger lines, so the stock
  // item names never reach the voucher. Fetch the default godown and allocate
  // every stock line to it.
  let defaultGodown: string | undefined;
  if (goodsItems.length > 0) {
    try {
      const godowns = await gateway.fetch('godowns', { company });
      const picked =
        godowns.find((g) => {
          const n = String(g.NAME || g.name || '').trim().toLowerCase();
          return n === 'primary' || n === 'main location';
        }) ?? godowns[0];
      const name = String(picked?.NAME || picked?.name || '').trim();
      if (name) {
        defaultGodown = name;
        log(`[Step 7/7: Voucher Posting] Allocating stock entries to godown "${name}".`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`[Step 7/7: Voucher Posting] Could not fetch godowns (${error}); stock entries may post as ledger lines.`);
    }
  }

  const voucherPayload = convertExtractedDataToVoucher(billData, company, defaultGodown);
  log(
    `[Step 7/7: Voucher Posting] Voucher carries ${voucherPayload.inventoryEntries?.length ?? 0} stock entry line(s) ` +
      `(${voucherPayload.ledgerEntries.length} ledger line(s)), godown=${defaultGodown ?? 'NONE'}.`,
  );

  if ((voucherPayload.inventoryEntries?.length ?? 0) > 0) {
    log('[Step 7/7: Voucher Posting] Ensuring purchase ledger is inventory-affected for item invoice allocations...');
    const repairRes = await gateway.postLedger(
      {
        name: 'Purchase Accounts',
        parent: 'Purchase Accounts',
        isInventoryAffected: true,
        action: 'Alter',
      },
      company,
    );
    if (repairRes.status === 'error') {
      log(`[Step 7/7: Voucher Posting] Could not alter Purchase Accounts ledger: ${repairRes.error}`);
    }
  }

  // Auto-create any ledger the voucher references that doesn't exist in Tally.
  // Steps 3-4 only create the vendor and stock-item masters; a voucher whose
  // tax/expense ledgers (e.g. "Input CGST", "Conveyance Expense") are absent
  // would otherwise be rejected by Tally with `Ledger 'X' does not exist!`.
  log('[Step 7/7: Voucher Posting] Verifying voucher-referenced ledgers exist in Tally...');
  try {
    const ledgers = await gateway.fetch('ledgers', { company });
    const existingLedgers = new Set(
      ledgers
        .map((l) => String(l.NAME || l.name || '').trim().toLowerCase())
        .filter(Boolean),
    );
    // Step 3 already ensured the party/vendor ledger exists.
    if (voucherPayload.partyLedgerName) {
      existingLedgers.add(voucherPayload.partyLedgerName.trim().toLowerCase());
    }

    for (const ledgerName of collectVoucherLedgerNames(voucherPayload)) {
      const key = ledgerName.trim().toLowerCase();
      if (existingLedgers.has(key)) continue;

      const ledgerPayload = ledgerPayloadForVoucherReference(ledgerName);
      log(`[Step 7/7: Voucher Posting] Ledger "${ledgerName}" not found. Creating under "${ledgerPayload.parent}"...`);
      const createRes = await gateway.postLedger(ledgerPayload, company);
      if (createRes.status === 'error') {
        log(`[Step 7/7: Voucher Posting] Failed to create ledger "${ledgerName}": ${createRes.error}`);
        return {
          ok: false,
          status: 'master_creation_error',
          error: `Failed to create ledger "${ledgerName}": ${createRes.error}`,
          calculatedTotal,
          extractedTotal: billData.extractedTotal,
          extractedBill: billData,
          logs: workflowLogs,
        };
      }
      existingLedgers.add(key);
      log(`[Step 7/7: Voucher Posting] Ledger "${ledgerName}" created successfully in Tally.`);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`[Step 7/7: Voucher Posting] Ledger verification failed: ${error}`);
    return {
      ok: false,
      status: 'tally_error',
      error: `Ledger verification failed: ${error}`,
      calculatedTotal,
      extractedTotal: billData.extractedTotal,
      extractedBill: billData,
      logs: workflowLogs,
    };
  }

  log(
    `[Step 7/7: Voucher Posting] Sending voucher to agent: type=${voucherPayload.voucherTypeName} num=${voucherPayload.voucherNumber} ` +
      `party="${voucherPayload.partyLedgerName}" isInvoice=${voucherPayload.isInvoice ?? false}` +
      `\n  Ledger entries (${voucherPayload.ledgerEntries.length}):` +
      voucherPayload.ledgerEntries
        .map(
          (le) => `\n    - ${le.ledgerName} | amount=${le.amount} | isDeemedPositive=${le.isDeemedPositive ?? (le.amount > 0)}`,
        )
        .join('') +
      `\n  Inventory entries (${voucherPayload.inventoryEntries?.length ?? 0}):` +
      (voucherPayload.inventoryEntries ?? [])
        .map(
          (ie) =>
            `\n    - ${ie.stockItemName} | rate=${ie.rate} | qty=${ie.quantity} | unit=${ie.unit ?? ''} | amount=${ie.amount} | isDeemedPositive=${ie.isDeemedPositive ?? (ie.amount > 0)}`,
        )
        .join('') +
      `\n  Full JSON payload sent to agent:\n${JSON.stringify(voucherPayload, null, 2)}`,
  );

  try {
    const postRes = await gateway.postVoucher(voucherPayload, company);

    if (postRes.status === 'error') {
      log(`[Step 7/7: Voucher Posting] Tally rejected voucher posting: ${postRes.error}`);
      return {
        ok: false,
        status: 'tally_error',
        error: `Tally rejected voucher posting: ${postRes.error}`,
        calculatedTotal,
        extractedTotal: billData.extractedTotal,
        extractedBill: billData,
        logs: workflowLogs,
      };
    }

    const voucherId = postRes.voucherId;
    log(
      `[Step 7/7: Voucher Posting] Purchase voucher created successfully in Tally! Voucher ID: ${voucherId ?? 'N/A'}, Bill Number: ${billData.bill.billNumber}`,
    );

    return {
      ok: true,
      status: 'created',
      voucherId,
      voucherNumber: billData.bill.billNumber,
      vendor: { name: billData.vendor.name, created: vendorCreated },
      items: itemsReport,
      calculatedTotal,
      extractedTotal: billData.extractedTotal,
      tallyResult: postRes,
      extractedBill: billData,
      logs: workflowLogs,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`[Step 7/7: Voucher Posting] Failed to post voucher to Tally: ${error}`);
    return {
      ok: false,
      status: 'tally_error',
      error: `Failed to post voucher to Tally: ${error}`,
      calculatedTotal,
      extractedTotal: billData.extractedTotal,
      extractedBill: billData,
      logs: workflowLogs,
    };
  }
}
