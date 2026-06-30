import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Layout, { Icon } from "../components/Layout";
import { api, Subject, DocumentMeta } from "../api";
import ReviewQuestions from "./ReviewQuestions";

interface DistRow { type: string; difficulty: string; count: number; points: number }
interface JobStatus { status: "running" | "done" | "error"; requested: number; generated: number; error?: string | null }
interface GenerationOptions { documents: { id: string; filename: string }[]; topics: string[] }

const QUESTION_TYPES = ["mcq", "true_false", "fill_blank", "essay", "matching"];

export default function EducatorDashboard() {
  const qc = useQueryClient();
  const { data: subjects = [] } = useQuery({ queryKey: ["subjects"], queryFn: () => api.get<Subject[]>("/subjects") });

  const [subjectId, setSubjectId] = useState("");
  const [documentIds, setDocumentIds] = useState<string[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [dist, setDist] = useState<DistRow[]>([{ type: "mcq", difficulty: "medium", count: 3, points: 5 }]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const sid = subjectId || subjects[0]?.id || "";

  const { data: documents = [] } = useQuery({
    queryKey: ["documents", sid],
    queryFn: () => api.get<DocumentMeta[]>(`/subjects/${sid}/documents`),
    enabled: !!sid,
    refetchInterval: 4000,
  });
  const readyDocuments = documents.filter((document) => document.status === "ready");
  const validDocumentIds = documentIds.filter((id) => readyDocuments.some((document) => document.id === id));
  const selectedDocumentIds = validDocumentIds.length > 0
    ? validDocumentIds : readyDocuments[0] ? [readyDocuments[0].id] : [];
  const selectedDocumentKey = selectedDocumentIds.join(",");
  const { data: generationOptions } = useQuery<GenerationOptions>({
    queryKey: ["generation-options", sid, selectedDocumentKey],
    queryFn: () => api.get<GenerationOptions>(
      `/subjects/${sid}/generation-options${selectedDocumentKey ? `?document_ids=${encodeURIComponent(selectedDocumentKey)}` : ""}`
    ),
    enabled: !!sid,
  });

  const { data: job } = useQuery<JobStatus>({
    queryKey: ["genjob", jobId],
    queryFn: () => api.get<JobStatus>(`/generation/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 2000 : false),
  });

  const start = useMutation({
    mutationFn: () => api.post<{ job_id: string }>(`/subjects/${sid}/generate`, {
      topic: topics.join("; "), document_ids: selectedDocumentIds, distribution: dist,
    }),
    onSuccess: (r) => { setJobId(r.job_id); setMsg(""); },
    onError: (e: any) => setMsg(`Error: ${e.message}`),
  });

  const running = job?.status === "running" || start.isPending;
  const updateRow = (i: number, patch: Partial<DistRow>) => setDist((d) => d.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const total = dist.reduce((s, r) => s + (Number(r.count) || 0), 0);

  useEffect(() => {
    if (job?.status === "done") qc.invalidateQueries({ queryKey: ["generated", sid] });
  }, [job?.status, qc, sid]);

  return (
    <Layout title="Generate & Review Questions">
      <div className="grid grid-cols-12 gap-6">
        {/* Left: exam configuration */}
        <section className="col-span-12 space-y-6">
          <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-8">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="font-headline text-2xl text-primary">Exam Configuration</h3>
                <p className="text-on-surface-variant">Generate intelligent assessment questions using the RAG framework.</p>
              </div>
              <div className="bg-tertiary-container text-tertiary-fixed px-4 py-2 rounded-lg flex items-center gap-2">
                <Icon name="auto_awesome" /><span className="text-sm font-semibold">AI Powered</span>
              </div>
            </div>

            <div className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                <div>
                  <label className="text-sm font-semibold text-on-surface">Subject (source material)</label>
                  <select value={sid} onChange={(e) => { setSubjectId(e.target.value); setDocumentIds([]); setTopics([]); }}
                    className="mt-1.5 w-full border border-outline-variant rounded-lg px-3 py-2.5 bg-white outline-none focus:border-secondary">
                    {subjects.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-sm font-semibold text-on-surface">Uploaded document(s)</label>
                  <DocumentDropdown documents={readyDocuments} selected={selectedDocumentIds}
                    onChange={(ids) => { setDocumentIds(ids); setTopics([]); }} />
                </div>
                <div>
                  <label className="text-sm font-semibold text-on-surface">Topic / focus</label>
                  <TopicDropdown options={generationOptions?.topics || []} selected={topics}
                    onChange={setTopics} disabled={selectedDocumentIds.length === 0} />
                </div>
              </div>
              {sid && readyDocuments.length === 0 && (
                <p className="text-sm text-error">Upload a document and wait for it to finish processing before generating questions.</p>
              )}

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-semibold text-on-surface">Question Distribution</label>
                  <span className="text-xs font-bold uppercase text-outline">Total: {total}</span>
                </div>
                <div className="space-y-3">
                  {dist.map((row, i) => (
                    <div key={i} className="flex items-end gap-3 bg-surface-container-low p-3 rounded-lg border border-outline-variant">
                      <Mini label="Type">
                        <select value={row.type} onChange={(e) => updateRow(i, { type: e.target.value })}
                          className="w-full bg-white border border-outline-variant rounded px-2 py-1.5 text-sm">
                          {QUESTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </Mini>
                      <Mini label="Difficulty">
                        <select value={row.difficulty} onChange={(e) => updateRow(i, { difficulty: e.target.value })}
                          className="w-full bg-white border border-outline-variant rounded px-2 py-1.5 text-sm">
                          <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
                        </select>
                      </Mini>
                      <Mini label="Count">
                        <input type="number" min={1} value={row.count} onChange={(e) => updateRow(i, { count: Number(e.target.value) })}
                          className="w-16 bg-white border border-outline-variant rounded px-2 py-1.5 text-sm" />
                      </Mini>
                      <Mini label="Pts">
                        <input type="number" min={1} value={row.points} onChange={(e) => updateRow(i, { points: Number(e.target.value) })}
                          className="w-16 bg-white border border-outline-variant rounded px-2 py-1.5 text-sm" />
                      </Mini>
                      <button onClick={() => setDist((d) => d.filter((_, idx) => idx !== i))} className="mb-1.5 text-outline hover:text-error">
                        <Icon name="delete" />
                      </button>
                    </div>
                  ))}
                </div>
                <button onClick={() => setDist((d) => [...d, { type: "true_false", difficulty: "easy", count: 2, points: 3 }])}
                  className="mt-3 w-full py-2 border border-dashed border-outline-variant rounded-lg text-secondary text-sm flex items-center justify-center gap-2 hover:bg-surface-container-low">
                  <Icon name="add_circle" className="text-[18px]" /> Add question type
                </button>
              </div>

              <div className="pt-4 border-t border-outline-variant flex items-center justify-between">
                <a href="#review-questions" className="text-secondary text-sm font-semibold hover:underline">Go to Review Questions →</a>
                <button onClick={() => { setMsg(""); start.mutate(); }} disabled={running || !sid || selectedDocumentIds.length === 0}
                  className="px-8 py-3 bg-secondary text-on-secondary rounded-lg font-semibold flex items-center gap-2 disabled:opacity-60">
                  <Icon name={running ? "sync" : "generating_tokens"} className={running ? "animate-spin" : ""} />
                  {running ? "Generating…" : "Generate Questions"}
                </button>
              </div>

              {job && (
                <div className="rounded-lg border border-outline-variant p-4 bg-surface-container-low text-sm">
                  {job.status === "running" && <p className="flex items-center gap-2"><Icon name="sync" className="animate-spin text-secondary" /> Generating {job.generated} of {job.requested}…</p>}
                  {job.status === "done" && <p className="text-secondary flex items-center gap-2"><Icon name="check_circle" /> Done — {job.generated} generated. <a href="#review-questions" className="font-semibold underline">Review →</a></p>}
                  {job.status === "error" && <p className="text-error">Failed: {job.error}</p>}
                </div>
              )}
              {msg && <p className="text-sm text-error">{msg}</p>}
            </div>
          </div>

        </section>

      </div>
      <div id="review-questions" className="mt-10 scroll-mt-24">
        <ReviewQuestions embedded subjectId={sid} />
      </div>
    </Layout>
  );
}

function DocumentDropdown({ documents, selected, onChange }: {
  documents: DocumentMeta[]; selected: string[]; onChange: (ids: string[]) => void;
}) {
  const selectedNames = documents.filter((document) => selected.includes(document.id)).map((document) => document.filename);
  const label = documents.length === 0
    ? "No ready documents"
    : selectedNames.length === 1 ? selectedNames[0] : `${selectedNames.length} documents selected`;
  return (
    <details className={`relative mt-1.5 group ${documents.length === 0 ? "pointer-events-none opacity-60" : ""}`}>
      <summary className="w-full border border-outline-variant rounded-lg px-3 py-2.5 bg-white cursor-pointer list-none flex items-center justify-between">
        <span className="truncate">{label}</span><Icon name="expand_more" className="text-[18px] group-open:rotate-180" />
      </summary>
      <div className="absolute z-30 mt-1 w-full max-h-64 overflow-y-auto rounded-lg border border-outline-variant bg-white shadow-xl p-2">
        {documents.length > 1 && (
          <button type="button" onClick={() => onChange(documents.map((document) => document.id))}
            className="w-full text-left px-2 py-2 rounded text-sm font-semibold text-secondary hover:bg-surface-container-low">
            Select all documents
          </button>
        )}
        {documents.map((document) => (
          <label key={document.id} className="flex items-center gap-2 px-2 py-2 rounded text-sm hover:bg-surface-container-low cursor-pointer">
            <input type="checkbox" checked={selected.includes(document.id)} onChange={(event) => {
              if (event.target.checked) onChange([...selected, document.id]);
              else if (selected.length > 1) onChange(selected.filter((id) => id !== document.id));
            }} />
            <span className="truncate" title={document.filename}>{document.filename}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

function TopicDropdown({ options, selected, onChange, disabled }: {
  options: string[]; selected: string[]; onChange: (topics: string[]) => void; disabled: boolean;
}) {
  const label = selected.length === 0
    ? "All topics in document"
    : selected.length === 1 ? selected[0] : `${selected.length} topics selected`;
  return (
    <details className={`relative mt-1.5 group ${disabled ? "pointer-events-none opacity-60" : ""}`}>
      <summary className="w-full border border-outline-variant rounded-lg px-3 py-2.5 bg-white cursor-pointer list-none flex items-center justify-between">
        <span className="truncate">{label}</span><Icon name="expand_more" className="text-[18px] group-open:rotate-180" />
      </summary>
      <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-lg border border-outline-variant bg-white shadow-xl p-2">
        <button type="button" onClick={() => onChange([])}
          className={`w-full text-left px-2 py-2 rounded text-sm ${selected.length === 0 ? "bg-secondary-container font-semibold" : "hover:bg-surface-container-low"}`}>
          All topics in document
        </button>
        {options.map((option) => (
          <label key={option} className="flex items-center gap-2 px-2 py-2 rounded text-sm hover:bg-surface-container-low cursor-pointer">
            <input type="checkbox" checked={selected.includes(option)} onChange={(event) =>
              onChange(event.target.checked ? [...selected, option] : selected.filter((item) => item !== option))
            } />
            <span>{option}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

function Mini({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex-1">
      <span className="text-[10px] text-outline uppercase font-bold block mb-1">{label}</span>
      {children}
    </div>
  );
}
