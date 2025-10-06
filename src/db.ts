// db.ts — Dexie schema + indexes + migration (v1.1)
import Dexie, { Table } from 'dexie';

export interface Task {
  id: string;
  text: string;
  dueAt?: string | null;       // ISO
  estimateMins?: number | null;
  tags?: string[];
  importanceHint?: number | null; // user nudges
  urgencyHint?: number | null;    // user nudges
  urgency: number;                // computed 0–5
  importance: number;             // computed 0–5
  quadrant: 'do'|'schedule'|'delegate'|'eliminate';
  aiSuggestion?: 'do'|'schedule'|'delegate'|'eliminate' | null;
  reasoning?: string;
  notionId?: string | null;       // future sync
  remindersId?: string | null;    // future sync
  createdAt: string;              // ISO
  doneAt?: string | null;
}

export interface Journal { id: string; ts: string; action: string; payload: any }

export class MatrixDB extends Dexie {
  tasks!: Table<Task, string>;
  journal!: Table<Journal, string>;
  constructor() {
    super('matrixDB');
    // v1 schema with improved indexes
    this.version(1).stores({
      tasks: 'id, [quadrant+dueAt], createdAt, doneAt',
      journal: 'id, ts'
    });
  }
}

export const db = new MatrixDB();

// -------- Heuristic Scoring (additive & clamped) --------
export function scoreUrgency(t: { dueAt?: string|null; text: string; urgencyHint?: number|null }): number {
  let u = 0;
  const now = new Date();
  if (t.dueAt) {
    const due = new Date(t.dueAt);
    const ms = due.getTime() - now.getTime();
    const days = ms / 86400000;
    if (due < now) u = 5; else if (days <= 0) u = 4; else if (days <= 2) u = 3;
  }
  const s = t.text.toLowerCase();
  if (/\b(asap|today|eod|tonight)\b/.test(s)) u += 3;
  if (/\b\d{1,2}:\d{2}\b/.test(s)) u += 1;
  if (typeof t.urgencyHint === 'number') u += t.urgencyHint;
  return Math.max(0, Math.min(5, u));
}

export function scoreImportance(t: { text: string; tags?: string[]; estimateMins?: number|null; importanceHint?: number|null }): number {
  let i = 0;
  const tags = (t.tags||[]).map(x=>x.toLowerCase());
  if (tags.some(x => ['clinic','patients','finance','safety','learning-core'].includes(x))) i += 3;
  if (/\b(okr|goal|milestone)\b/i.test(t.text)) i += 2;
  if ((t.estimateMins||0) >= 60) i += 1;
  if (/\b(clean inbox|file receipts|tweak theme)\b/i.test(t.text)) i -= 2;
  if (typeof t.importanceHint === 'number') i += t.importanceHint;
  return Math.max(0, Math.min(5, i));
}

export type Quadrant = 'do'|'schedule'|'delegate'|'eliminate';

export function decideQuadrant(u:number, i:number): Quadrant {
  if (u>=3 && i>=3) return 'do';
  if (u<=2 && i>=3) return 'schedule';
  if (u>=3 && i<=2) return 'delegate';
  return 'eliminate';
}

export function computeBadges(t: {text:string; dueAt?:string|null; tags?:string[]; estimateMins?:number|null}): string[] {
  const b: string[] = [];
  const now = new Date();
  if (t.dueAt) {
    const due = new Date(t.dueAt);
    const days = (due.getTime()-now.getTime())/86400000;
    if (due < now) b.push('overdue');
    else if (days<=0) b.push('today');
    else if (days<=2) b.push('due<48h');
  }
  const s = t.text.toLowerCase();
  if (/\b\d{1,2}:\d{2}\b/.test(s)) b.push('time');
  (t.tags||[]).forEach(tag => b.push(tag.toLowerCase()));
  if (/\b(okr|goal|milestone)\b/i.test(t.text)) b.push('okr');
  if ((t.estimateMins||0) >= 60) b.push('deep');
  if (/\b(clean inbox|file receipts|tweak theme)\b/i.test(t.text)) b.push('low');
  return b;
}

export function isBorderline(u:number, i:number, q:Quadrant){
  const edge = (u===2||u===3||i===2||i===3);
  const sumGate = (u+i)>=4 && (u+i)<=7;
  const flipCandidate = (
    (q==='do' && (u===3 && i===3)) ||
    (q==='schedule' && (u===2 && i>=3)) ||
    (q==='delegate' && (u>=3 && i===2)) ||
    (q==='eliminate' && (u<=2 && i<=2))
  );
  return (edge && sumGate) || flipCandidate;
}

export function buildReasoning(badges:string[]): string {
  const s = badges.join('; ');
  return s.length>280 ? s.slice(0,277)+'…' : s;
}

// -------- Migration from sessionStorage --------
export async function migrateFromSessionStorage(key = 'matrix-tasks'): Promise<number> {
  const raw = typeof window !== 'undefined' ? window.sessionStorage.getItem(key) : null;
  if (!raw) return 0;
  let arr: any[] = [];
  try { arr = JSON.parse(raw) as any[]; } catch { return 0; }
  let count = 0;
  await db.transaction('rw', db.tasks, db.journal, async () => {
    for (const t of arr) {
      const id = t.id || (crypto && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now())+Math.random());
      const createdAt = t.createdAt || new Date().toISOString();
      const dueAt = t.dueAt ? new Date(t.dueAt).toISOString() : null;
      const urgency = Number.isFinite(t.urgency) ? t.urgency : scoreUrgency({ dueAt, text: t.text||'' , urgencyHint: t.urgencyHint||null });
      const importance = Number.isFinite(t.importance) ? t.importance : scoreImportance({ text: t.text||'', tags: t.tags||[], estimateMins: t.estimateMins||null, importanceHint: t.importanceHint||null });
      const quadrant = (t.quadrant) || decideQuadrant(urgency, importance);
      const badges = computeBadges({ text: t.text||'', dueAt, tags: t.tags||[], estimateMins: t.estimateMins||null });
      const reasoning = t.reasoning || buildReasoning(badges);
      const record: Task = { id, text: t.text||'', dueAt, estimateMins: t.estimateMins||null, tags: t.tags||[], importanceHint: t.importanceHint||null, urgencyHint: t.urgencyHint||null, urgency, importance, quadrant, aiSuggestion: t.aiSuggestion||null, reasoning, notionId: t.notionId||null, remindersId: t.remindersId||null, createdAt, doneAt: t.doneAt||null };
      await db.tasks.put(record);
      await db.journal.add({ id: crypto.randomUUID(), ts: new Date().toISOString(), action: 'migrate', payload: { id } });
      count++;
    }
  });
  return count;
}
