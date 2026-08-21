/*
 * Demo data for the Pet Shop Invoice Assistant prototype.
 * Everything here is mocked/scripted — there is no real OCR or backend.
 * See README.md for what's real vs. simulated.
 */

const STORES = [
  { id: 'lim-centre',  name: 'Limassol Theos shop' },
  { id: 'lim-marina',  name: 'Limassol Mikes shop' },
  { id: 'nic-makariou',name: 'Nicosia Nicos shop' },
  { id: 'nic-strovolos',name: 'Nicosia – Strovolos' },
  { id: 'lar-finik',   name: 'Larnaca – Finikoudes' },
  { id: 'paf-kato',    name: 'Paphos – Kato Paphos' },
];

const PERSONAS = [
  {
    id: 'elena',
    name: 'Elena K.',
    role: 'employee',
    roleLabel: 'Employee',
    stores: ['lim-centre', 'lim-marina'],
    code: '7421',
  },
  {
    id: 'marios',
    name: 'Marios D.',
    role: 'manager',
    roleLabel: 'Manager',
    stores: ['nic-makariou'],
    code: '7421',
  },
  {
    id: 'alexandros',
    name: 'Alexandros P.',
    role: 'owner',
    roleLabel: 'Owner',
    stores: STORES.map(s => s.id),
    code: '7421',
  },
];

// Product master data, keyed by barcode. This is the "existing stock card"
// data — pack multipliers live here, never guessed on the fly.
const PRODUCTS = {
  '5201234500019': { name: 'Royal Canin Mini Adult 2kg', unit: 'pc', packMultiplier: 1, category: 'Dog food' },
  '5201234500026': { name: 'Royal Canin Mini Adult 8kg', unit: 'pc', packMultiplier: 1, category: 'Dog food' },
  '5201234500033': { name: 'Whiskas Adult Chicken 1.2kg', unit: 'pc', packMultiplier: 1, category: 'Cat food' },
  '5201234500040': { name: 'Pedigree Puppy 3kg', unit: 'pc', packMultiplier: 1, category: 'Dog food' },
  '5201234500057': { name: 'Felix Fantastic Mixed 12x85g', unit: 'pc', packMultiplier: 12, category: 'Cat food' },
  '5201234500064': { name: 'Pro Plan Sterilised 1.5kg', unit: 'pc', packMultiplier: 1, category: 'Cat food' },
  '4001122334455': { name: 'Frontline Spot-On Cat 3x0.5ml', unit: 'pc', packMultiplier: 1, category: 'Health' },
  '4001122334462': { name: 'Advocate Dog 4-10kg 4pk', unit: 'pc', packMultiplier: 1, category: 'Health' },
  '4001122334479': { name: 'Bravecto Chew 20-40kg', unit: 'pc', packMultiplier: 1, category: 'Health' },
  '4001122334486': { name: 'Milbemax Small Dog 4tab', unit: 'pc', packMultiplier: 1, category: 'Health' },
  '4001122334493': { name: 'Nobivac Vaccine Vial', unit: 'pc', packMultiplier: 1, category: 'Health' },
  '4001122334509': { name: 'Seresto Collar Cat', unit: 'pc', packMultiplier: 1, category: 'Health' },
  '4001122334516': { name: 'Revolution Plus Cat 2.8-5.4kg', unit: 'pc', packMultiplier: 1, category: 'Health' },
  '4001122334523': { name: 'Capstar Tablets 6pk', unit: 'pc', packMultiplier: 1, category: 'Health' },
  '4001122334530': { name: 'Program Suspension Cat', unit: 'pc', packMultiplier: 1, category: 'Health' },
  '6009876543210': { name: 'Aqua Filter Cartridge M', unit: 'pc', packMultiplier: 1, category: 'Aquarium' },
  '6009876543227': { name: 'Fish Tank Heater 50W', unit: 'pc', packMultiplier: 1, category: 'Aquarium' },
  // Note: product card says "pack of 20", invoice will print "pack of 24" -> mismatch demo
  '6009876543234': { name: 'AquaGold Shrimp Pellets Pack of 20', unit: 'pack', packMultiplier: 20, category: 'Aquarium' },
};

// Helper to build a line item.
function item(barcode, qtyPrinted, price, opts = {}) {
  const master = PRODUCTS[barcode];
  return {
    barcode,
    name: opts.name || (master ? master.name : 'Unrecognized item'),
    qtyPrinted,          // quantity exactly as printed on the invoice
    unit: opts.unit || (master ? master.unit : 'pc'),
    price,
    lineTotal: +(qtyPrinted * price).toFixed(2),
    confidence: opts.confidence || 'high', // high | low
    isNew: !master && !opts.isBatch,
    isBatch: !!opts.isBatch,
    packInvoice: opts.packInvoice || null, // { size, ok } for pack-multiplier checks
    handwritten: !!opts.handwritten,
  };
}

const SCENARIOS = {
  propet: {
    key: 'propet',
    supplier: 'Propet Cyprus Ltd',
    blurb: 'Clean scan, a couple of handwritten corrections to confirm.',
    header: {
      supplier: 'Propet Cyprus Ltd',
      invoiceNo: 'PR-88213',
      orderNo: 'SO-4471',
      invoiceDate: '2026-08-14',
      dueDate: '2026-09-13',
      subtotal: 736.80,
      vat: 139.99,
      total: 876.79,
      qtyPrinted: 65,
    },
    pagesExpected: 2,
    pagesProvided: 2,
    items: [
      item('5201234500019', 12, 14.90),
      item('5201234500026', 6, 42.10),
      item('5201234500033', 24, 3.85, { confidence: 'low', handwritten: true }),
      item('5201234500040', 10, 9.20),
      item('5201234500057', 5, 5.40, { packInvoice: { size: 12 } }),
      item('5201234500064', 8, 11.75, { confidence: 'low' }),
    ],
    extraPages: [],
  },

  vetline: {
    key: 'vetline',
    supplier: 'VetLine Supplies',
    blurb: 'Only page 1 was photographed — totals will not add up.',
    header: {
      supplier: 'VetLine Supplies',
      invoiceNo: 'VL-30567',
      orderNo: '—',
      invoiceDate: '2026-08-11',
      dueDate: '2026-09-10',
      subtotal: 1380.60,
      vat: 262.31,
      total: 1642.91,
      qtyPrinted: 60,
    },
    pagesExpected: 3,
    pagesProvided: 1,
    items: [
      item('4001122334455', 8, 24.50),
      item('4001122334462', 6, 32.00),
      item('4001122334479', 4, 45.00),
      item('4001122334486', 10, 12.30),
      item('4001122334493', 5, 38.00, { confidence: 'low', handwritten: true }),
    ],
    // Revealed once the presenter "adds the missing pages".
    extraPages: [
      item('4001122334509', 6, 22.00),
      item('4001122334516', 5, 28.60),
      item('4001122334523', 12, 9.75),
      item('4001122334530', 4, 26.90),
    ],
  },

  aquaworld: {
    key: 'aquaworld',
    supplier: 'AquaWorld Distributors',
    blurb: 'A pack-size mismatch, plus 10 new flavours to add in one batch.',
    header: {
      supplier: 'AquaWorld Distributors',
      invoiceNo: 'AW-11209',
      orderNo: 'PO-2291',
      invoiceDate: '2026-08-18',
      dueDate: '2026-09-17',
      subtotal: 512.60,
      vat: 97.39,
      total: 609.99,
      qtyPrinted: 90,
    },
    pagesExpected: 1,
    pagesProvided: 1,
    items: [
      item('6009876543210', 15, 6.00),
      item('6009876543227', 8, 14.50),
      // invoice prints "Pack of 24"; product card says pack of 20 -> warning
      item('6009876543234', 3, 18.00, { packInvoice: { size: 24 } }),
      // unknown barcode, single new product (not part of the batch below)
      item('6099887766554', 4, 9.90, { name: 'AquaBoost Vitamin Drops 30ml' }),
    ],
    extraPages: [],
    // 10 unknown barcodes belonging to one new product line -> batch flow
    batch: {
      label: 'AquaFin Flavour Mix 6x100g',
      category: 'Fish food',
      unit: 'pc',
      packMultiplier: 1,
      priceEach: 3.55,
      qtyEach: 6,
      lineTotal: 213.00,
      flavours: [
        'Tropical Flakes', 'Goldfish Mix', 'Cichlid Blend', 'Shrimp & Krill',
        'Algae Wafer', 'Bloodworm Mix', 'Betta Formula', 'Discus Blend',
        'Koi Pellets', 'Marine Mix',
      ],
      barcodeBase: '600987655',
    },
  },
};

// Seed history so the History screen isn't empty on first load.
function seedHistory() {
  return [
    {
      id: 'h1', date: '2026-08-17', supplier: 'Propet Cyprus Ltd',
      store: 'lim-centre', enteredBy: 'Elena K.', status: 'auto', total: 654.20,
    },
    {
      id: 'h2', date: '2026-08-16', supplier: 'VetLine Supplies',
      store: 'nic-makariou', enteredBy: 'Marios D.', status: 'review', total: 1120.00,
    },
    {
      id: 'h3', date: '2026-08-15', supplier: 'AquaWorld Distributors',
      store: 'paf-kato', enteredBy: 'Alexandros P.', status: 'auto', total: 389.40,
    },
    {
      id: 'h4', date: '2026-08-14', supplier: 'Propet Cyprus Ltd',
      store: 'lar-finik', enteredBy: 'Marios D.', status: 'draft', total: 0,
      note: 'Left mid-entry — 2 clarifications unresolved.',
    },
  ];
}
