import { useMemo, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Layout, { Icon } from "../components/Layout";
import { api, Subject, DocumentMeta } from "../api";
import { useAuth } from "../auth";

const statusStyle: Record<string, string> = {
  ready: "bg-green-100 text-green-800",
  processing: "bg-blue-100 text-blue-800",
  uploaded: "bg-surface-container-high text-on-surface-variant",
  error: "bg-error-container text-on-error-container",
};

export default function Materials() {
  const { id } = useParams();
  const { data: subjects = [] } = useQuery({
    queryKey: ["subjects"],
    queryFn: () => api.get<Subject[]>("/subjects"),
  });

  if (!id) {
    return (
      <Layout title="Learning Materials">
        <p className="text-on-surface-variant mb-6">Select a subject to manage its learning materials.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {subjects.map((s) => (
            <Link
              key={s.id}
              to={`/subjects/${s.id}/materials`}
              className="bg-surface-container-lowest border border-outline-variant rounded-xl p-6 hover:shadow-lg hover:border-secondary transition-all flex items-center gap-4"
            >
              <div className="w-12 h-12 rounded-lg bg-secondary-container flex items-center justify-center text-on-secondary-container">
                <Icon name="folder_open" />
              </div>
              <div>
                <p className="font-headline text-lg text-primary">{s.name}</p>
                <p className="text-sm text-on-surface-variant">{s.code}</p>
              </div>
            </Link>
          ))}
          {subjects.length === 0 && <p className="text-on-surface-variant">No subjects yet.</p>}
        </div>
      </Layout>
    );
  }

  return <SubjectMaterials subjectId={id} subjects={subjects} />;
}

function SubjectMaterials({ subjectId, subjects }: { subjectId: string; subjects: Subject[] }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { user } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadModule, setUploadModule] = useState("Module 1");
  const [customModules, setCustomModules] = useState<string[]>([]);
  const [newModule, setNewModule] = useState("");
  const subject = subjects.find((s) => s.id === subjectId);
  const canManage = user?.role === "educator" || user?.role === "admin";

  const { data: docs = [] } = useQuery({
    queryKey: ["documents", subjectId],
    queryFn: () => api.get<DocumentMeta[]>(`/subjects/${subjectId}/documents`),
    refetchInterval: 4000,
  });
  const moduleLabels = useMemo(() => {
    const labels = docs.map((doc) => doc.module_label || "Module 1");
    return Array.from(new Set(["Module 1", ...customModules, ...labels])).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [customModules, docs]);
  const groupedDocs = useMemo(() => {
    return docs.reduce<Record<string, DocumentMeta[]>>((groups, doc) => {
      const label = doc.module_label || "Module 1";
      groups[label] = [...(groups[label] || []), doc];
      return groups;
    }, {});
  }, [docs]);

  const upload = useMutation({
    mutationFn: async ({ files, moduleLabel }: { files: File[]; moduleLabel: string }) => {
      const results = await Promise.allSettled(
        files.map((file) => api.upload(`/subjects/${subjectId}/documents`, file, { module_label: moduleLabel })),
      );
      const failedFiles = results
        .map((result, index) => ({ result, file: files[index] }))
        .filter(({ result }) => result.status === "rejected")
        .map(({ file }) => file.name);

      if (failedFiles.length > 0) {
        throw new Error(
          `${files.length - failedFiles.length} of ${files.length} uploaded. Failed: ${failedFiles.join(", ")}`,
        );
      }
      return results;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["documents", subjectId] }),
  });

  const openUpload = (moduleLabel: string) => {
    setUploadModule(moduleLabel);
    fileRef.current?.click();
  };

  const remove = useMutation({
    mutationFn: (docId: string) => api.del(`/subjects/${subjectId}/documents/${docId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["documents", subjectId] }),
  });

  return (
    <Layout title="Learning Materials">
      <button onClick={() => nav("/subjects")}
        className="flex items-center gap-1 text-secondary text-sm font-semibold mb-4 hover:underline">
        <Icon name="arrow_back" className="text-[18px]" /> Back to Subjects
      </button>

      <div className="mb-6">
        <h2 className="font-headline text-2xl text-primary">{subject?.name || "Subject"}</h2>
        <p className="text-on-surface-variant">
          {subject?.code} • Materials uploaded here are used only for this subject's question generation.
        </p>
      </div>

      <div className="flex items-center gap-1 border-b border-outline-variant mb-7">
        <Link to={`/subjects/${subjectId}`}
          className="inline-flex items-center gap-2 whitespace-nowrap px-5 py-3 border-b-2 border-transparent text-on-surface-variant font-semibold transition-colors hover:text-secondary">
          <Icon name="quiz" className="text-[20px]" /> {canManage ? "Subject Quizzes" : "Published Quizzes"}
        </Link>
        {canManage && (
          <Link to={`/subjects/${subjectId}?tab=grading`}
            className="inline-flex items-center gap-2 whitespace-nowrap px-5 py-3 border-b-2 border-transparent text-on-surface-variant font-semibold transition-colors hover:text-secondary">
            <Icon name="fact_check" className="text-[20px]" /> Grade Submissions
          </Link>
        )}
        <span className="inline-flex items-center gap-2 whitespace-nowrap px-5 py-3 border-b-2 border-secondary text-secondary font-semibold">
          <Icon name="folder_open" className="text-[20px]" /> Materials
        </span>
      </div>

      {canManage && (
        <>
          <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-5 mb-6">
            <div className="max-w-xl">
                <label className="text-sm font-semibold text-on-surface">Add module</label>
                <div className="mt-1.5 flex gap-2">
                  <input
                    value={newModule}
                    onChange={(event) => setNewModule(event.target.value)}
                    placeholder="Module 2"
                    className="min-w-0 flex-1 border border-outline-variant rounded-lg px-3 py-2.5 bg-white text-on-surface"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const label = newModule.trim().replace(/\s+/g, " ");
                      if (!label) return;
                      setCustomModules((modules) => modules.includes(label) ? modules : [...modules, label]);
                      setNewModule("");
                    }}
                    className="inline-flex items-center justify-center gap-2 bg-secondary text-on-secondary px-4 py-2.5 rounded-lg font-semibold"
                  >
                    <Icon name="add" className="text-[19px]" /> Add
                  </button>
                </div>
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            disabled={upload.isPending}
            className="hidden"
            accept=".pdf,.docx,.pptx,.xlsx,.odt,.html,.htm,.rtf,.txt,.md,.csv,.png,.jpg,.jpeg"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              if (files.length > 0) upload.mutate({ files, moduleLabel: uploadModule });
              e.target.value = "";
            }}
          />
        </>
      )}

      {upload.isError && (
        <p className="text-error text-sm mb-4">{(upload.error as Error).message}</p>
      )}

      <div className="space-y-5">
        {moduleLabels.map((label) => {
          const moduleDocs = groupedDocs[label] || [];
          return (
            <section key={label} className="bg-surface-container-lowest rounded-xl border border-outline-variant overflow-hidden">
              <div className="px-6 py-4 bg-surface-container-low border-b border-outline-variant flex items-center justify-between gap-3">
                <h3 className="font-headline text-lg font-bold text-primary flex items-center gap-2">
                  <Icon name="folder" className="text-[22px]" /> {label}
                </h3>
                <span className="text-xs font-semibold text-on-surface-variant">{moduleDocs.length} material{moduleDocs.length === 1 ? "" : "s"}</span>
              </div>
              {moduleDocs.length > 0 ? (
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-outline-variant text-sm text-on-surface-variant">
                      <th className="px-6 py-4">Name</th>
                      <th className="px-6 py-4">Type</th>
                      <th className="px-6 py-4">Size</th>
                      <th className="px-6 py-4">Status</th>
                      <th className="px-6 py-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant">
                    {moduleDocs.map((d) => (
                      <tr key={d.id} className="group">
                        <td className="px-6 py-4 font-medium text-on-surface">{d.filename}</td>
                        <td className="px-6 py-4 text-on-surface-variant uppercase">{d.file_type}</td>
                        <td className="px-6 py-4 text-on-surface-variant">{(d.size_bytes / 1024).toFixed(1)} KB</td>
                        <td className="px-6 py-4">
                          <span className={`px-2 py-1 rounded-full text-xs font-bold capitalize ${statusStyle[d.status] || ""}`}>
                            {d.status}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={() => {
                              if (confirm(`Delete "${d.filename}"? This also removes its indexed content.`)) {
                                remove.mutate(d.id);
                              }
                            }}
                            disabled={remove.isPending}
                            className="p-2 text-on-surface-variant hover:text-error transition-colors disabled:opacity-50"
                            title="Delete"
                          >
                            <Icon name="delete" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="p-6 text-sm text-on-surface-variant">No materials in this module yet.</p>
              )}
              {canManage && (
                <button
                  type="button"
                  onClick={() => openUpload(label)}
                  disabled={upload.isPending}
                  className="m-5 w-[calc(100%-2.5rem)] border-2 border-dashed border-outline-variant rounded-xl px-5 py-5 text-left hover:border-secondary hover:bg-surface-container-low transition-colors disabled:opacity-60"
                >
                  <span className="flex items-center gap-3">
                    <span className="w-11 h-11 rounded-lg bg-secondary-container text-secondary flex items-center justify-center">
                      <Icon name={upload.isPending && uploadModule === label ? "sync" : "cloud_upload"} className={upload.isPending && uploadModule === label ? "animate-spin" : ""} />
                    </span>
                    <span>
                      <span className="block font-semibold text-on-surface">
                        {upload.isPending && uploadModule === label ? "Uploading..." : `Upload files to ${label}`}
                      </span>
                      <span className="block text-sm text-on-surface-variant">
                        PDF, DOCX, PPTX, XLSX, ODT, HTML, RTF, TXT, MD, CSV, PNG, and JPG are supported.
                      </span>
                    </span>
                  </span>
                </button>
              )}
            </section>
          );
        })}
      </div>
    </Layout>
  );
}
