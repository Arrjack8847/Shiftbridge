/**
 * server/rule-defaults.js — Shared rule definitions.
 * Exported separately so both seed.js and the server can import them.
 */

export const ruleDefaults = [
  { id: 'inventory', name: 'Stock checks', note: 'Count and confirm supplies', allowed: true },
  { id: 'cleaning', name: 'Routine cleaning', note: 'Regular low-risk cleaning work', allowed: true },
  { id: 'opening', name: 'Opening preparation', note: 'Preapproved startup activities', allowed: true },
  { id: 'repairs', name: 'Equipment repairs', note: 'Qualified review always required', allowed: false, locked: true },
  { id: 'purchases', name: 'Purchases and spending', note: 'Owner approval required', allowed: false, locked: true },
  { id: 'safety', name: 'Safety clearance', note: 'Qualified human verification required', allowed: false, locked: true },
];
