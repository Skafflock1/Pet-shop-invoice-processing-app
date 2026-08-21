/*
 * Shared between the browser (js/app.js) and the backend (api/recognize.js):
 * the tool schema and system prompt used to extract a structured invoice
 * from photos via Claude's vision + forced tool-use. Loaded as a plain
 * <script> in the browser (attaches to `self`) and via require() in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const INVOICE_TOOL = {
    name: 'record_invoice',
    description: 'Record the structured data extracted from a photographed supplier invoice.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['supplier', 'invoiceNo', 'orderNo', 'invoiceDate', 'dueDate', 'subtotal', 'vat', 'total', 'qtyPrinted', 'pagesExpected', 'items'],
      properties: {
        supplier: { type: 'string', description: 'Supplier / vendor name as printed.' },
        invoiceNo: { type: 'string', description: 'Invoice number. Always present on a real invoice.' },
        orderNo: { type: 'string', description: 'Purchase order number, or "—" if none printed.' },
        invoiceDate: { type: 'string', description: 'Invoice date as printed (use YYYY-MM-DD if you can tell the format, otherwise copy as printed).' },
        dueDate: { type: 'string', description: 'Payment due date as printed, or "" if none.' },
        subtotal: { type: 'number', description: 'Total before VAT/tax, as a plain number with no currency symbol.' },
        vat: { type: 'number', description: 'VAT / tax amount, as a plain number.' },
        total: { type: 'number', description: 'Grand total including VAT/tax, as a plain number.' },
        qtyPrinted: { type: 'number', description: 'The total-quantity figure printed on the invoice, if any; 0 if none is printed.' },
        pagesExpected: { type: 'integer', description: 'The Y in a "Page X of Y" marker, if printed anywhere. If no such marker is visible, set this to the number of photos you were given.' },
        items: {
          type: 'array',
          description: 'Every line item on the invoice, across all pages given.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['barcode', 'name', 'qty', 'unit', 'price', 'confidence', 'reason', 'packSize'],
            properties: {
              barcode: { type: 'string', description: 'Barcode/SKU as printed. Empty string if none is visible on this line.' },
              name: { type: 'string', description: 'Product description as printed.' },
              qty: { type: 'number', description: 'Quantity as printed for this line (in whatever unit the invoice prints — packs, cases, or individual units).' },
              unit: { type: 'string', description: 'Unit the quantity is printed in, e.g. "pc", "pack", "box", "kg".' },
              price: { type: 'number', description: 'Unit price as printed for this line, as a plain number.' },
              confidence: { type: 'string', enum: ['high', 'low'], description: '"low" if this line was handwritten, corrected, smudged, or otherwise hard to read — even if you gave your best guess.' },
              reason: { type: 'string', description: 'If confidence is "low", a short reason (e.g. "handwritten quantity", "barcode partly smudged"). Empty string if confidence is "high".' },
              packSize: { type: 'number', description: 'If the line explicitly states a pack/case size (e.g. "Pack of 12", "12x85g"), the number of units per pack. 0 if no such notation appears.' },
            },
          },
        },
      },
    },
  };

  const LIVE_SYSTEM_PROMPT = 'You are extracting structured data from photographed pages of a single supplier invoice for a pet shop\'s stock system. You will be given one or more photos, in page order, followed by an instruction. Read both printed and handwritten text, including corrections written over printed values. Report money fields as plain numbers with no currency symbol. If a photo shows multiple pages are stapled or a "Page X of Y" marker, use it to fill in pagesExpected. Always call the record_invoice tool with your best-effort extraction — never refuse or ask a clarifying question, since a human will review every low-confidence field afterward.';

  const LIVE_MODELS = [
    { id: 'claude-opus-5', label: 'Claude Opus 5', hint: 'best accuracy · ~$0.05/invoice' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', hint: 'balanced · ~$0.02/invoice' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', hint: 'fastest & cheapest · ~$0.01/invoice' },
  ];

  return { INVOICE_TOOL, LIVE_SYSTEM_PROMPT, LIVE_MODELS };
});
