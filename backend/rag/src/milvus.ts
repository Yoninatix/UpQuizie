import { MilvusClient, DataType } from "@zilliz/milvus2-sdk-node";

const ADDRESS = process.env.MILVUS_ADDRESS || "milvus:19530";
const DIM = parseInt(process.env.EMBED_DIM || "768", 10);
const COLLECTION = "upquiz_chunks";

let client: MilvusClient | null = null;
let collectionReady = false;

export async function getClient(): Promise<MilvusClient> {
  if (!client) client = new MilvusClient({ address: ADDRESS });
  // The client is cached, but readiness is tracked separately so an early
  // failure (Milvus not up yet) doesn't permanently skip collection creation.
  if (!collectionReady) {
    await ensureCollection(client);
    collectionReady = true;
  }
  return client;
}

async function ensureCollection(c: MilvusClient) {
  const has = await c.hasCollection({ collection_name: COLLECTION });
  if (has.value) {
    await c.loadCollectionSync({ collection_name: COLLECTION });
    return;
  }

  await c.createCollection({
    collection_name: COLLECTION,
    fields: [
      { name: "id", data_type: DataType.Int64, is_primary_key: true, autoID: true },
      { name: "document_id", data_type: DataType.VarChar, max_length: 64 },
      { name: "subject_id", data_type: DataType.VarChar, max_length: 64 },
      { name: "chunk_index", data_type: DataType.Int64 },
      { name: "text", data_type: DataType.VarChar, max_length: 8192 },
      { name: "embedding", data_type: DataType.FloatVector, dim: DIM },
    ],
  });

  // IVF_FLAT index with cosine similarity (per thesis Chapter IV).
  await c.createIndex({
    collection_name: COLLECTION,
    field_name: "embedding",
    index_type: "IVF_FLAT",
    metric_type: "COSINE",
    params: { nlist: 128 },
  });

  await c.loadCollectionSync({ collection_name: COLLECTION });

  const confirm = await c.hasCollection({ collection_name: COLLECTION });
  if (!confirm.value) throw new Error("collection creation did not persist");
}

export interface ChunkVector {
  document_id: string;
  subject_id: string;
  chunk_index: number;
  text: string;
  embedding: number[];
}

// Insert vectors and return the auto-generated Milvus primary keys (in order).
export async function insertChunks(chunks: ChunkVector[]): Promise<string[]> {
  const c = await getClient();
  const res = await c.insert({ collection_name: COLLECTION, data: chunks as any });
  await c.flushSync({ collection_names: [COLLECTION] });
  const ids = (res as any).IDs?.int_id?.data || (res as any).IDs?.IdField?.IntId?.data || [];
  return (ids as Array<string | number>).map((x) => String(x));
}

// Remove all vectors belonging to a document.
export async function deleteByDocument(documentId: string): Promise<void> {
  const c = await getClient();
  await c.deleteEntities({
    collection_name: COLLECTION,
    filter: `document_id == "${documentId}"`,
  });
  await c.flushSync({ collection_names: [COLLECTION] });
}

// Remove all vectors belonging to a subject.
export async function deleteBySubject(subjectId: string): Promise<void> {
  const c = await getClient();
  await c.deleteEntities({
    collection_name: COLLECTION,
    filter: `subject_id == "${subjectId}"`,
  });
  await c.flushSync({ collection_names: [COLLECTION] });
}

export interface SearchHit {
  text: string;
  document_id: string;
  chunk_index: number;
  score: number;
}

export async function search(
  subjectId: string,
  vector: number[],
  topK = 5,
  documentIds: string[] = []
): Promise<SearchHit[]> {
  const c = await getClient();
  const filters = [];
  if (subjectId) filters.push(`subject_id == "${subjectId}"`);
  if (documentIds.length) filters.push(`document_id in [${documentIds.map((id) => `"${id}"`).join(",")}]`);
  const res = await c.search({
    collection_name: COLLECTION,
    data: [vector],
    limit: topK,
    filter: filters.length ? filters.join(" and ") : undefined,
    output_fields: ["text", "document_id", "chunk_index"],
    metric_type: "COSINE",
  });
  return (res.results || []).map((r: any) => ({
    text: r.text,
    document_id: r.document_id,
    chunk_index: Number(r.chunk_index),
    score: r.score,
  }));
}

export { COLLECTION, DIM };
