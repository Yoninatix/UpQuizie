import { useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Layout, { Icon } from "../components/Layout";
import { api, Subject, DocumentMeta } from "../api";

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
  const fileRef = useRef<HTMLInputElement>(null);
  const subject = subjects.find((s) => s.id === subjectId);

  const { data: docs = [] } = useQuery({
    queryKey: ["documents", subjectId],
    queryFn: () => api.get<DocumentMeta[]>(`/subjects/${subjectId}/documents`),
    refetchInterval: 4000,
  });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const results = await Promise.allSettled(
        files.map((file) => api.upload(`/subjects/${subjectId}/documents`, file)),
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
          className="px-5 py-3 text-on-surface-variant font-semibold flex items-center gap-2 hover:text-secondary">
          <Icon name="quiz" className="text-[20px]" /> Published Quizzes
        </Link>
        <span className="px-5 py-3 border-b-2 border-secondary text-secondary font-semibold flex items-center gap-2">
          <Icon name="folder_open" className="text-[20px]" /> Materials
        </span>
      </div>

      <div
        onClick={() => fileRef.current?.click()}
        className="bg-surface-container-lowest border-2 border-dashed border-outline-variant rounded-xl p-10 flex flex-col items-center text-center cursor-pointer hover:border-secondary mb-8"
      >
        <div className="w-16 h-16 rounded-full bg-secondary-container flex items-center justify-center text-secondary mb-4">
          <Icon name="cloud_upload" className="text-4xl" />
        </div>
        <h3 className="font-headline text-xl text-on-surface mb-1">
          {upload.isPending ? "Uploading documents..." : "Click to upload documents"}
        </h3>
        <p className="text-sm text-on-surface-variant max-w-md">
          Select one or multiple files. PDF, DOCX, PPTX, XLSX, ODT, HTML, RTF, TXT, MD, and CSV are supported.
        </p>
        <input
          ref={fileRef}
          type="file"
          multiple
          disabled={upload.isPending}
          className="hidden"
          accept=".pdf,.docx,.pptx,.xlsx,.odt,.html,.htm,.rtf,.txt,.md,.csv,.png,.jpg,.jpeg"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            if (files.length > 0) upload.mutate(files);
            e.target.value = "";
          }}
        />
      </div>

      {upload.isError && (
        <p className="text-error text-sm mb-4">{(upload.error as Error).message}</p>
      )}

      <div className="bg-surface-container-lowest rounded-xl border border-outline-variant overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-surface-container-low border-b border-outline-variant text-sm text-on-surface-variant">
              <th className="px-6 py-4">Name</th>
              <th className="px-6 py-4">Type</th>
              <th className="px-6 py-4">Size</th>
              <th className="px-6 py-4">Status</th>
              <th className="px-6 py-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant">
            {docs.map((d) => (
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
        {docs.length === 0 && <p className="p-6 text-on-surface-variant">No materials for this subject yet.</p>}
      </div>
    </Layout>
  );
}
