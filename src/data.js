/**
 * src/data.js — Demo people, helpers, and client-side identity storage.
 *
 * The server is the single source of truth for shared data (messages,
 * tasks, issues, workspaces, rules). This file provides:
 *   - demoPeople (static identity list for the demo selector)
 *   - escapeHTML, safeID, displayTime, formatDate (UI helpers)
 *   - getIdentity / setIdentity (persists the selected demo identity in localStorage)
 *   - ruleDefaults (used for display fallback only)
 */

export const demoPeople = [
  { id:'jack', name:'Jack', initials:'J', hue:'sea', role:'Employee' },
  { id:'emma', name:'Emma', initials:'E', hue:'lavender', role:'Employee' },
  { id:'sarah', name:'Sarah', initials:'S', hue:'rose', role:'Shift Lead' },
  { id:'manager', name:'Manager', initials:'M', hue:'orange', role:'Administrator' },
  { id:'liam', name:'Liam', initials:'L', hue:'blue', role:'Employee' }
];

export const ruleDefaults = [
  { id:'inventory', name:'Stock checks', note:'Count and confirm supplies', allowed:true },
  { id:'cleaning', name:'Routine cleaning', note:'Regular low-risk cleaning work', allowed:true },
  { id:'opening', name:'Opening preparation', note:'Preapproved startup activities', allowed:true },
  { id:'repairs', name:'Equipment repairs', note:'Qualified review always required', allowed:false, locked:true },
  { id:'purchases', name:'Purchases and spending', note:'Owner approval required', allowed:false, locked:true },
  { id:'safety', name:'Safety clearance', note:'Qualified human verification required', allowed:false, locked:true }
];

/** Escape HTML special characters to prevent XSS in string interpolation. */
export function escapeHTML(value='') {
  return String(value).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

/** Generate a unique ID with a prefix. Used for client-generated IDs (idempotent POST). */
export function safeID(prefix='id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
}

/** Format a timestamp for display (e.g. "9:30 AM"). */
export function displayTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('en-MY', { hour:'numeric', minute:'2-digit' });
}

/** Format a timestamp as a full date (e.g. "Saturday, Oct 10"). */
export function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString('en-MY', { weekday:'long', day:'numeric', month:'short' });
}

// ── Identity (stored in localStorage — NOT shared data) ─────────────

const IDENTITY_KEY = 'shiftbridge.identity';

/**
 * Get the selected demo identity from localStorage.
 * Returns { userId, role } or null if not yet selected.
 */
export function getIdentity() {
  try {
    const stored = JSON.parse(localStorage.getItem(IDENTITY_KEY) || 'null');
    if (stored && stored.userId && demoPeople.some(p => p.id === stored.userId)) {
      return stored;
    }
  } catch { /* ignore */ }
  return null;
}

/** Save the selected demo identity to localStorage. */
export function setIdentity(userId) {
  const person = demoPeople.find(p => p.id === userId);
  if (!person) return;
  const role = person.id === 'manager' ? 'admin' : 'employee';
  localStorage.setItem(IDENTITY_KEY, JSON.stringify({ userId, role }));
}

/** Clear the selected identity. */
export function clearIdentity() {
  localStorage.removeItem(IDENTITY_KEY);
}

/** Determine role from userId. */
export function roleForUser(userId) {
  return userId === 'manager' ? 'admin' : 'employee';
}
