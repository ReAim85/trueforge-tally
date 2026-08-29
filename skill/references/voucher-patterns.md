# common voucher patterns

example json payloads for creating different types of vouchers in tally. amounts follow the convention: positive = debit, negative = credit.

## sales invoice with gst (intra state)

selling goods worth 10000 rs with 18% gst (9% cgst + 9% sgst) to a customer in the same state:

```json
{
  "voucherTypeName": "Sales",
  "date": "2026-08-29",
  "partyLedgerName": "Acme Corp",
  "isInvoice": true,
  "narration": "sale of electronics",
  "ledgerEntries": [
    { "ledgerName": "Acme Corp", "amount": 11800 },
    { "ledgerName": "Sales Account", "amount": -10000 },
    { "ledgerName": "CGST Output", "amount": -900 },
    { "ledgerName": "SGST Output", "amount": -900 }
  ]
}
```

the party is debited for the full amount (goods + tax), and the sales and tax ledgers are credited.

## purchase with inventory (intra state)

buying 100 units of a product at 50 rs each with 18% gst:

```json
{
  "voucherTypeName": "Purchase",
  "date": "2026-08-29",
  "partyLedgerName": "Supplier Ltd",
  "isInvoice": true,
  "narration": "purchase of raw materials",
  "ledgerEntries": [
    { "ledgerName": "Supplier Ltd", "amount": -5900 },
    { "ledgerName": "Purchase Account", "amount": 5000 },
    { "ledgerName": "CGST Input", "amount": 450 },
    { "ledgerName": "SGST Input", "amount": 450 }
  ],
  "inventoryEntries": [
    {
      "stockItemName": "Widget A",
      "quantity": 100,
      "rate": 50,
      "amount": 5000
    }
  ]
}
```

the party is credited (you owe them), purchase and tax input ledgers are debited.

## payment

paying a supplier 5900 rs via bank transfer:

```json
{
  "voucherTypeName": "Payment",
  "date": "2026-08-29",
  "partyLedgerName": "Supplier Ltd",
  "narration": "payment against invoice 123",
  "ledgerEntries": [
    { "ledgerName": "Supplier Ltd", "amount": 5900 },
    { "ledgerName": "HDFC Bank", "amount": -5900 }
  ]
}
```

the party is debited (reducing what you owe), bank is credited (money goes out).

## receipt

receiving 11800 rs from a customer:

```json
{
  "voucherTypeName": "Receipt",
  "date": "2026-08-29",
  "partyLedgerName": "Acme Corp",
  "narration": "received payment for invoice 456",
  "ledgerEntries": [
    { "ledgerName": "Acme Corp", "amount": -11800 },
    { "ledgerName": "HDFC Bank", "amount": 11800 }
  ]
}
```

the party is credited (reducing what they owe), bank is debited (money comes in).

## journal entry

adjusting an expense, transferring 5000 rs from one expense head to another:

```json
{
  "voucherTypeName": "Journal",
  "date": "2026-08-29",
  "partyLedgerName": "Office Expenses",
  "narration": "reclassification of expense",
  "ledgerEntries": [
    { "ledgerName": "Travel Expenses", "amount": 5000 },
    { "ledgerName": "Office Expenses", "amount": -5000 }
  ]
}
```

## inter state sale with igst

selling goods worth 10000 rs with 18% igst to a customer in another state:

```json
{
  "voucherTypeName": "Sales",
  "date": "2026-08-29",
  "partyLedgerName": "Mumbai Traders",
  "isInvoice": true,
  "narration": "inter state sale",
  "ledgerEntries": [
    { "ledgerName": "Mumbai Traders", "amount": 11800 },
    { "ledgerName": "Sales Account", "amount": -10000 },
    { "ledgerName": "IGST Output", "amount": -1800 }
  ]
}
```

## tips

- ledger entries must always balance: sum of all amounts should be zero
- the party ledger name must match an existing ledger in tally, or create one first
- for inventory vouchers, include both ledger entries and inventory entries
- bill allocations are used to track which invoice a payment is for
- always use the exact ledger names as they appear in tally, they are case sensitive
