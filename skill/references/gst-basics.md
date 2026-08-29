# gst basics for tally

goods and services tax (gst) is india's unified indirect tax. here is what you need to know when creating entries in tally.

## tax components

gst is split into components based on where the transaction happens:

- **intra state** (buyer and seller in the same state): cgst + sgst, each is half the total rate
  - example: 18% gst becomes 9% cgst + 9% sgst
- **inter state** (buyer and seller in different states): igst, full rate
  - example: 18% gst becomes 18% igst

## common tax rates

- 0% for essentials like fresh food, milk
- 5% for packaged food, footwear under 1000 rs
- 12% for processed food, computers, bicycles
- 18% for most services, electronics, capital goods (most common rate)
- 28% for luxury items, cars, tobacco

## hsn and sac codes

- hsn (harmonized system of nomenclature) codes are for goods, usually 4 or 8 digits
- sac (services accounting code) codes are for services, usually 6 digits
- every stock item in tally should have the right hsn code for gst compliance

## registration types

when creating a ledger for a customer or supplier, set the gst registration type:

- regular: normal gst registered business, can claim input tax credit
- composition: small businesses paying tax at a flat rate, cannot charge gst on invoices
- consumer: end consumers, no gstin
- unregistered: businesses not registered for gst

## gstin format

a gstin is 15 characters: first 2 digits are state code, next 10 are pan, then entity number, z, and a check digit. example: 29AABCT1234F1Z5

## tax ledgers in tally

for gst accounting, you need these ledgers under "duties and taxes":

- cgst output (for sales within state)
- sgst output (for sales within state)
- igst output (for sales outside state)
- cgst input (for purchases within state)
- sgst input (for purchases within state)
- igst input (for purchases outside state)

## place of supply

the place of supply determines whether cgst+sgst or igst applies:

- for goods: where the goods are delivered
- for services: where the recipient is located

if the place of supply is the same state as the supplier, use cgst+sgst. otherwise use igst.
