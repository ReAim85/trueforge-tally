# tally data model

tallyprime organizes accounting data into 13 entity types. here is what each one does and how they relate.

## companies

the top level container. a single tally installation can have multiple companies open at once. every other entity lives inside a company.

## groups

groups organize ledgers into a hierarchy. tally comes with built in groups like:

- sundry creditors (suppliers you owe money to)
- sundry debtors (customers who owe you money)
- bank accounts
- cash in hand
- duties and taxes (for gst, tds, etc)
- sales accounts
- purchase accounts
- direct expenses, indirect expenses
- direct incomes, indirect incomes

you can create sub groups under these.

## ledgers

ledgers are the actual accounts. every transaction touches at least two ledgers. examples:

- a customer account under sundry debtors
- hdfc bank under bank accounts
- cgst output under duties and taxes
- office rent under indirect expenses

each ledger has a parent group, and optionally has opening balance, address, gstin, and contact details.

## voucher types

these define what kind of transaction you are recording:

- sales: selling goods or services
- purchase: buying goods or services
- payment: paying money out
- receipt: receiving money in
- contra: transferring between bank and cash
- journal: adjustments and corrections
- credit note: returns from customers
- debit note: returns to suppliers

## vouchers

vouchers are the actual transactions. each voucher has:

- a type (from voucher types above)
- a date
- a party ledger (who you are dealing with)
- ledger entries (the debit and credit lines)
- optional inventory entries (for stock movements)
- a narration (notes)

## stock groups

organize stock items into categories, similar to how groups organize ledgers. example: electronics, raw materials, finished goods.

## stock categories

another way to classify stock items, used less often than stock groups.

## stock items

the actual products or materials you buy and sell. each stock item has:

- a name
- a parent stock group
- a base unit of measure
- optional opening balance, rate, and value
- optional hsn code and gst rate

## units

measurement units like nos (numbers), kg (kilograms), pcs (pieces), box, ltr (litres). stock items reference these.

## godowns

storage locations or warehouses. stock items can be tracked across multiple godowns.

## cost centres

used to track expenses and income by department, project, or branch. optional feature.

## cost categories

group cost centres together. rarely used in small businesses.

## currencies

currency definitions. most indian businesses only use inr but tally supports multi currency accounting.
