// EisenhowerMatrix.tsx — Refactored React component (v1.1)
// Local-first; heuristic-first autosort; optional local LLM refine toggle.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { db, Task, Quadrant, scoreUrgency, scoreImportance, decideQuadrant, isBorderline, computeBadges, buildReasoning } from './db';

// Optional local refine (Ollama). Only used when user toggles it on AND case is borderline.
async function refineWithOllama(text: string, heuristic: Quadrant, timeoutMs = 3000): Promise<{quadrant: Quadrant, reasoning: string}> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = {
      model: 'llama3.2',
      prompt: `You categorize 1 task into an Eisenhower quadrant. Return ONLY JSON {"quadrant":"...","reasoning":"..."}. Definitions: do=urgent & important; schedule=not urgent & important; delegate=urgent & not important; eliminate=neither. Task: "${text}" Heuristic: "${heuristic}"`,
      options: { temperature: 0.2 },
      stream: false
    };
    const r = await fetch('http://localhost:11434/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal
    });
    clearTimeout(id);
    if (!r.ok) throw new Error('ollama not ok');
    const out = await r.json();
    const raw = String(out.response || '').replace(/^```[\s\S]*?\n|```$/g,'').trim();
    const parsed = JSON.parse(raw);
    const q = (parsed.quadrant || heuristic) as Quadrant;
    const reason = typeof parsed.reasoning === 'string' ? parsed.reasoning : 'refined';
    return { quadrant: q, reasoning: reason };
  } catch (_) {
    return { quadrant: heuristic, reasoning: 'offline fallback' };
  }
}

// Utility: sanitize text before sending to any model
function sanitizeForModel(s: string): string {
  return s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
          .replace(/\b\+?\d[\d \-()]{6,}\b/g, '[phone]')
          .replace(/https?:\/\/\S+/g, '[url]')
          .replace(/\b[A-Z0-9]{8,}\b/g, '[id]');
}

const QUADRANTS: Quadrant[] = ['do','schedule','delegate','eliminate'];

export default function EisenhowerMatrix() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState('');
  const [enableRefine, setEnableRefine] = useState(false); // user toggle

  useEffect(() => {
    let mounted = true;
    (async () => {
      const all = await db.tasks.toArray();
      if (mounted) { setTasks(all); setReady(true); }
    })();
    return () => { mounted = false; };
  }, []);

  // Derived columns with autosort
  const columns = useMemo(() => {
    const byQ: Record<Quadrant, Task[]> = { do: [], schedule: [], delegate: [], eliminate: [] };
    for (const t of tasks) byQ[t.quadrant].push(t);
    for (const q of QUADRANTS) {
      byQ[q] = byQ[q].sort((a,b) => {
        // importance desc, urgency desc, createdAt asc
        if (b.importance !== a.importance) return b.importance - a.importance;
        if (b.urgency !== a.urgency) return b.urgency - a.urgency;
        return (a.createdAt||'').localeCompare(b.createdAt||'');
      });
    }
    return byQ;
  }, [tasks]);

  async function addTask(text: string) {
    if (!text.trim()) return;
    const id = crypto.randomUUID();
    const dueAt = null; // user can edit later
    const urgency = scoreUrgency({ dueAt, text });
    const importance = scoreImportance({ text, tags: [], estimateMins: null });
    const quadrant = decideQuadrant(urgency, importance);
    const badges = computeBadges({ text, dueAt, tags: [], estimateMins: null });
    let reasoning = buildReasoning(badges);
    let aiSuggestion: Quadrant | null = null;

    if (enableRefine && isBorderline(urgency, importance, quadrant)) {
      const sani = sanitizeForModel(text);
      const r = await refineWithOllama(sani, quadrant);
      aiSuggestion = r.quadrant;
      reasoning = `${reasoning}${reasoning ? ' | ' : ''}LLM: ${r.reasoning}`.slice(0,280);
    }

    const record: Task = {
      id, text, dueAt, estimateMins: null, tags: [],
      importanceHint: null, urgencyHint: null,
      urgency, importance, quadrant, aiSuggestion,
      reasoning, notionId: null, remindersId: null,
      createdAt: new Date().toISOString(), doneAt: null
    };
    await db.tasks.put(record);
    setTasks(prev => [record, ...prev]);
    setInput('');
  }

  async function setQuadrant(id: string, quadrant: Quadrant) {
    const t = tasks.find(x=>x.id===id);
    if (!t) return;
    const updated = { ...t, quadrant } as Task;
    await db.tasks.put(updated);
    setTasks(prev => prev.map(x => x.id===id ? updated : x));
  }

  async function toggleDone(id: string) {
    const t = tasks.find(x=>x.id===id);
    if (!t) return;
    const doneAt = t.doneAt ? null : new Date().toISOString();
    const updated = { ...t, doneAt } as Task;
    await db.tasks.put(updated);
    setTasks(prev => prev.map(x => x.id===id ? updated : x));
  }

  async function eliminate(id: string) {
    const t = tasks.find(x=>x.id===id);
    if (!t) return;
    const updated = { ...t, quadrant: 'eliminate' as Quadrant } as Task;
    await db.tasks.put(updated);
    setTasks(prev => prev.map(x => x.id===id ? updated : x));
  }

  // Basic keyboard shortcuts: Enter to add
  const inputRef = useRef<HTMLInputElement|null>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  if (!ready) return <div style={{ padding: 16 }}>Loading…</div>;

  return (
    <div style={{ padding: 16, fontFamily: 'ui-sans-serif, system-ui' }}>
      <h1 style={{ fontSize: 20, fontWeight: 600 }}>Eisenhower Matrix</h1>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e)=>setInput(e.target.value)}
          onKeyDown={(e)=>{ if(e.key==='Enter') addTask(input); }}
          placeholder="Add a task and press Enter"
          style={{ flex: 1, padding: '8px 10px', border: '1px solid #ddd', borderRadius: 8 }}
        />
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
          <input type="checkbox" checked={enableRefine} onChange={e=>setEnableRefine(e.target.checked)} />
          Local refine
        </label>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Column title="Do (Urgent & Important)" tasks={columns.do} onSetQuadrant={setQuadrant} onToggleDone={toggleDone} onEliminate={eliminate} />
        <Column title="Schedule (Important)" tasks={columns.schedule} onSetQuadrant={setQuadrant} onToggleDone={toggleDone} onEliminate={eliminate} />
        <Column title="Delegate (Urgent)" tasks={columns.delegate} onSetQuadrant={setQuadrant} onToggleDone={toggleDone} onEliminate={eliminate} />
        <Column title="Eliminate" tasks={columns.eliminate} onSetQuadrant={setQuadrant} onToggleDone={toggleDone} onEliminate={eliminate} />
      </div>
    </div>
  );
}

function Column({ title, tasks, onSetQuadrant, onToggleDone, onEliminate }:{
  title: string;
  tasks: Task[];
  onSetQuadrant: (id:string, q:Quadrant)=>void|Promise<void>;
  onToggleDone: (id:string)=>void|Promise<void>;
  onEliminate: (id:string)=>void|Promise<void>;
}){
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tasks.map(t => (
          <Card key={t.id} task={t} onSetQuadrant={onSetQuadrant} onToggleDone={onToggleDone} onEliminate={onEliminate} />
        ))}
        {tasks.length===0 && <div style={{ color: '#888', fontSize: 12 }}>No tasks</div>}
      </div>
    </div>
  );
}

function Card({ task: t, onSetQuadrant, onToggleDone, onEliminate }:{
  task: Task;
  onSetQuadrant: (id:string, q:Quadrant)=>void|Promise<void>;
  onToggleDone: (id:string)=>void|Promise<void>;
  onEliminate: (id:string)=>void|Promise<void>;
}){
  const badge = (s:string, i:number) => (
    <span key={i} style={{ background:'#f5f5f5', border:'1px solid #eee', padding:'2px 6px', borderRadius: 999, fontSize:10 }}>{s}</span>
  );
  const badges = (t.reasoning||'').split(';').map(s=>s.trim()).filter(Boolean);

  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 10, padding: 10, display:'flex', gap: 8, alignItems:'flex-start' }}>
      <input type="checkbox" checked={!!t.doneAt} onChange={()=>onToggleDone(t.id)} title="toggle done" />
      <div style={{ flex:1 }}>
        <div style={{ fontWeight: 600, lineHeight: 1.2 }}>{t.text}</div>
        <div style={{ marginTop: 6, display:'flex', gap:6, flexWrap:'wrap' }}>
          <span style={{ fontSize: 11, color: '#666' }}>U:{t.urgency} I:{t.importance}</span>
          {badges.slice(0,6).map(badge)}
          {t.aiSuggestion && <span style={{ fontSize:10, color:'#6b7280' }}>AI:{t.aiSuggestion}</span>}
        </div>
      </div>
      <select value={t.quadrant} onChange={(e)=>onSetQuadrant(t.id, e.target.value as Quadrant)} title="move quadrant" style={{ fontSize: 12 }}>
        <option value="do">do</option>
        <option value="schedule">schedule</option>
        <option value="delegate">delegate</option>
        <option value="eliminate">eliminate</option>
      </select>
      <button onClick={()=>onEliminate(t.id)} title="eliminate" style={{ fontSize:12, border:'1px solid #eee', background:'#fafafa', borderRadius:8, padding:'4px 6px' }}>✕</button>
    </div>
  );
}
