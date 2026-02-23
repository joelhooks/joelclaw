import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond, respondError } from "../response"
import { isTypesenseApiKeyError, resolveTypesenseApiKey } from "../typesense-auth"

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108"
const DOCS_COLLECTION = "docs"
const DOCS_CHUNKS_COLLECTION = "docs_chunks"
const DEFAULT_LIMIT = 10
const DEFAULT_LIST_LIMIT = 20

type TypesenseHit = {
  document?: Record<string, unknown>
  highlights?: Array<{ field?: string; snippet?: string }>
  text_match_info?: { score?: number }
  hybrid_search_info?: { rank_fusion_score?: number }
}

type TypesenseSearchResponse = {
  found?: number
  page?: number
  hits?: TypesenseHit[]
  facet_counts?: Array<{
    field_name?: string
    counts?: Array<{ value?: string | number; count?: number }>
  }>
}

type DocsDocument = {
  id: string
  title: string
  filename?: string
  nasPath: string
  storageCategory?: string
  documentType?: string
  fileType?: string
  summary?: string
  tags: string[]
  primaryConceptId?: string
  conceptIds: string[]
  conceptSource?: string
  taxonomyVersion?: string
  addedAt?: number
  sizeBytes?: number
  sourceHost?: string
}

type DocsChunk = {
  id: string
  docId: string
  title: string
  chunkType: "section" | "snippet"
  chunkIndex: number
  headingPath: string[]
  contextPrefix: string
  parentChunkId?: string
  prevChunkId?: string
  nextChunkId?: string
  primaryConceptId?: string
  conceptIds: string[]
  conceptSource?: string
  taxonomyVersion?: string
  sourceEntityId?: string
  evidenceTier?: string
  parentEvidenceId?: string
  content?: string
  retrievalText?: string
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function quoteFilterValue(value: string): string {
  const escaped = value.replace(/`/g, "\\`")
  return `\`${escaped}\``
}

function parseTagsCsv(input: string | undefined): string[] {
  if (!input) return []
  return input
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

function normalizeDocument(document: Record<string, unknown>): DocsDocument | null {
  const id = asString(document.id)
  const title = asString(document.title)
  const nasPath = asString(document.nas_path)
  if (!id || !title || !nasPath) return null

  return {
    id,
    title,
    filename: asString(document.filename),
    nasPath,
    storageCategory: asString(document.storage_category),
    documentType: asString(document.document_type),
    fileType: asString(document.file_type),
    summary: asString(document.summary),
    tags: asStringArray(document.tags),
    primaryConceptId: asString(document.primary_concept_id),
    conceptIds: asStringArray(document.concept_ids),
    conceptSource: asString(document.concept_source),
    taxonomyVersion: asString(document.taxonomy_version),
    addedAt: asNumber(document.added_at),
    sizeBytes: asNumber(document.size_bytes),
    sourceHost: asString(document.source_host),
  }
}

function normalizeChunk(document: Record<string, unknown>): DocsChunk | null {
  const id = asString(document.id)
  const docId = asString(document.doc_id)
  const title = asString(document.title)
  const chunkTypeRaw = asString(document.chunk_type)
  const chunkIndex = asNumber(document.chunk_index)
  if (!id || !docId || !title || !chunkTypeRaw || chunkIndex == null) return null
  if (chunkTypeRaw !== "section" && chunkTypeRaw !== "snippet") return null

  return {
    id,
    docId,
    title,
    chunkType: chunkTypeRaw,
    chunkIndex,
    headingPath: asStringArray(document.heading_path),
    contextPrefix: asString(document.context_prefix) ?? "",
    parentChunkId: asString(document.parent_chunk_id),
    prevChunkId: asString(document.prev_chunk_id),
    nextChunkId: asString(document.next_chunk_id),
    primaryConceptId: asString(document.primary_concept_id),
    conceptIds: asStringArray(document.concept_ids),
    conceptSource: asString(document.concept_source),
    taxonomyVersion: asString(document.taxonomy_version),
    sourceEntityId: asString(document.source_entity_id),
    evidenceTier: asString(document.evidence_tier),
    parentEvidenceId: asString(document.parent_evidence_id),
    content: asString(document.content),
    retrievalText: asString(document.retrieval_text),
  }
}

async function typesenseRequest(
  apiKey: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  return fetch(`${TYPESENSE_URL}${path}`, {
    ...(init ?? {}),
    headers: {
      "X-TYPESENSE-API-KEY": apiKey,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
}

async function typesenseSearch(
  apiKey: string,
  collection: string,
  params: URLSearchParams
): Promise<TypesenseSearchResponse> {
  const response = await typesenseRequest(
    apiKey,
    `/collections/${collection}/documents/search?${params.toString()}`,
    { method: "GET" }
  )
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Typesense search failed (${response.status}): ${errorText}`)
  }
  return (await response.json()) as TypesenseSearchResponse
}

async function getDocById(apiKey: string, docId: string): Promise<DocsDocument | null> {
  const response = await typesenseRequest(
    apiKey,
    `/collections/${DOCS_COLLECTION}/documents/${encodeURIComponent(docId)}`,
    { method: "GET" }
  )
  if (response.status === 404) return null
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to fetch doc ${docId}: ${errorText}`)
  }
  const payload = (await response.json()) as Record<string, unknown>
  return normalizeDocument(payload)
}

async function getChunkById(apiKey: string, chunkId: string): Promise<DocsChunk | null> {
  const response = await typesenseRequest(
    apiKey,
    `/collections/${DOCS_CHUNKS_COLLECTION}/documents/${encodeURIComponent(chunkId)}`,
    { method: "GET" }
  )
  if (response.status === 404) return null
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to fetch chunk ${chunkId}: ${errorText}`)
  }
  const payload = (await response.json()) as Record<string, unknown>
  return normalizeChunk(payload)
}

async function listDocIdsByCategory(apiKey: string, category: string): Promise<string[]> {
  const perPage = 250
  const maxPages = 20
  const ids: string[] = []

  for (let page = 1; page <= maxPages; page += 1) {
    const params = new URLSearchParams({
      q: "*",
      query_by: "title",
      per_page: String(perPage),
      page: String(page),
      include_fields: "id",
      filter_by: `storage_category:=${quoteFilterValue(category)}`,
      exclude_fields: "embedding",
    })

    const result = await typesenseSearch(apiKey, DOCS_COLLECTION, params)
    const hits = result.hits ?? []
    if (hits.length === 0) break

    for (const hit of hits) {
      const id = asString(hit.document?.id)
      if (id) ids.push(id)
    }
    if (hits.length < perPage) break
  }

  return ids
}

function scoreFromHit(hit: TypesenseHit): number | undefined {
  const score = hit.hybrid_search_info?.rank_fusion_score ?? hit.text_match_info?.score
  return typeof score === "number" ? score : undefined
}

function firstSnippet(hit: TypesenseHit): string | undefined {
  for (const highlight of hit.highlights ?? []) {
    const snippet = asString(highlight.snippet)
    if (snippet) return snippet
  }
  return undefined
}

function renderChunkText(chunk: DocsChunk): string {
  const prefix = chunk.contextPrefix ? `${chunk.contextPrefix}\n\n` : ""
  const body = chunk.content ?? chunk.retrievalText ?? ""
  return `${prefix}${body}`.trim()
}

async function collectSnippetWindow(
  apiKey: string,
  snippet: DocsChunk,
  before: number,
  after: number
): Promise<DocsChunk[]> {
  const previous: DocsChunk[] = []
  let cursor = snippet
  for (let i = 0; i < before; i += 1) {
    if (!cursor.prevChunkId) break
    const prev = await getChunkById(apiKey, cursor.prevChunkId)
    if (!prev) break
    previous.unshift(prev)
    cursor = prev
  }

  const following: DocsChunk[] = []
  cursor = snippet
  for (let i = 0; i < after; i += 1) {
    if (!cursor.nextChunkId) break
    const next = await getChunkById(apiKey, cursor.nextChunkId)
    if (!next) break
    following.push(next)
    cursor = next
  }

  return [...previous, snippet, ...following]
}

async function resolveParentSection(apiKey: string, chunk: DocsChunk): Promise<DocsChunk> {
  if (chunk.chunkType === "section") return chunk
  if (!chunk.parentChunkId) {
    throw new Error(`Chunk ${chunk.id} has no parent section`)
  }
  const parent = await getChunkById(apiKey, chunk.parentChunkId)
  if (!parent) {
    throw new Error(`Parent section ${chunk.parentChunkId} not found`)
  }
  return parent
}

async function fetchSnippetsForParentSection(
  apiKey: string,
  parentChunkId: string
): Promise<DocsChunk[]> {
  const params = new URLSearchParams({
    q: "*",
    query_by: "content",
    per_page: "250",
    sort_by: "chunk_index:asc",
    filter_by: `parent_chunk_id:=${quoteFilterValue(parentChunkId)} && chunk_type:=snippet`,
    include_fields: "id,doc_id,title,chunk_type,chunk_index,heading_path,context_prefix,parent_chunk_id,prev_chunk_id,next_chunk_id,primary_concept_id,concept_ids,concept_source,taxonomy_version,source_entity_id,evidence_tier,parent_evidence_id,content,retrieval_text",
    exclude_fields: "embedding",
  })
  const result = await typesenseSearch(apiKey, DOCS_CHUNKS_COLLECTION, params)
  return (result.hits ?? [])
    .map((hit) => (hit.document ? normalizeChunk(hit.document) : null))
    .filter((chunk): chunk is DocsChunk => chunk != null)
}

async function collectNeighborSections(
  apiKey: string,
  section: DocsChunk,
  neighbors: number
): Promise<DocsChunk[]> {
  const previous: DocsChunk[] = []
  let cursor = section
  for (let i = 0; i < neighbors; i += 1) {
    if (!cursor.prevChunkId) break
    const prev = await getChunkById(apiKey, cursor.prevChunkId)
    if (!prev || prev.chunkType !== "section") break
    previous.unshift(prev)
    cursor = prev
  }

  const following: DocsChunk[] = []
  cursor = section
  for (let i = 0; i < neighbors; i += 1) {
    if (!cursor.nextChunkId) break
    const next = await getChunkById(apiKey, cursor.nextChunkId)
    if (!next || next.chunkType !== "section") break
    following.push(next)
    cursor = next
  }

  return [...previous, section, ...following]
}

async function fetchSnippetsForSections(
  apiKey: string,
  sectionIds: string[]
): Promise<DocsChunk[]> {
  if (sectionIds.length === 0) return []
  const filterValues = sectionIds.map((value) => quoteFilterValue(value)).join(",")
  const params = new URLSearchParams({
    q: "*",
    query_by: "content",
    per_page: "250",
    sort_by: "chunk_index:asc",
    filter_by: `parent_chunk_id:[${filterValues}] && chunk_type:=snippet`,
    include_fields: "id,doc_id,title,chunk_type,chunk_index,heading_path,context_prefix,parent_chunk_id,prev_chunk_id,next_chunk_id,primary_concept_id,concept_ids,concept_source,taxonomy_version,source_entity_id,evidence_tier,parent_evidence_id,content,retrieval_text",
    exclude_fields: "embedding",
  })
  const result = await typesenseSearch(apiKey, DOCS_CHUNKS_COLLECTION, params)
  return (result.hits ?? [])
    .map((hit) => (hit.document ? normalizeChunk(hit.document) : null))
    .filter((chunk): chunk is DocsChunk => chunk != null)
}

const searchCmd = Command.make(
  "search",
  {
    query: Args.text({ name: "query" }),
    limit: Options.integer("limit").pipe(Options.withAlias("n"), Options.withDefault(DEFAULT_LIMIT)),
    category: Options.text("category").pipe(Options.optional),
    concept: Options.text("concept").pipe(Options.optional),
    chunkType: Options.text("chunk-type").pipe(Options.optional),
    docId: Options.text("doc").pipe(Options.optional),
    semantic: Options.boolean("semantic").pipe(Options.withDefault(true)),
  },
  ({ query, limit, category, concept, chunkType, docId, semantic }) =>
    Effect.gen(function* () {
      try {
        const apiKey = resolveTypesenseApiKey()
        const filters: string[] = []

        const categoryValue = category._tag === "Some" ? category.value.trim() : undefined
        const conceptValue = concept._tag === "Some" ? concept.value.trim() : undefined
        const chunkTypeValue = chunkType._tag === "Some" ? chunkType.value.trim() : undefined
        const docIdValue = docId._tag === "Some" ? docId.value.trim() : undefined

        if (docIdValue) {
          filters.push(`doc_id:=${quoteFilterValue(docIdValue)}`)
        }
        if (conceptValue) {
          filters.push(`concept_ids:=[${quoteFilterValue(conceptValue)}]`)
        }
        if (chunkTypeValue) {
          filters.push(`chunk_type:=${quoteFilterValue(chunkTypeValue)}`)
        }
        if (categoryValue) {
          const allowedDocIds = yield* Effect.promise(() =>
            listDocIdsByCategory(apiKey, categoryValue)
          )
          if (allowedDocIds.length === 0) {
            yield* Console.log(
              respond("docs search", {
                query,
                found: 0,
                hits: [],
                filters: {
                  category: categoryValue,
                  concept: conceptValue,
                  chunkType: chunkTypeValue,
                  docId: docIdValue,
                },
                reason: "No docs found for category filter",
              }, [
                { command: "joelclaw docs list", description: "List available docs" },
                { command: "joelclaw docs status", description: "Check docs index stats" },
              ])
            )
            return
          }
          const filterValues = allowedDocIds.map((value) => quoteFilterValue(value)).join(",")
          filters.push(`doc_id:[${filterValues}]`)
        }

        const params = new URLSearchParams({
          q: query,
          query_by: semantic ? "retrieval_text,content,embedding" : "retrieval_text,content",
          per_page: String(limit),
          include_fields: "id,doc_id,title,chunk_type,chunk_index,heading_path,context_prefix,parent_chunk_id,prev_chunk_id,next_chunk_id,primary_concept_id,concept_ids,taxonomy_version,evidence_tier,parent_evidence_id,source_entity_id,content",
          exclude_fields: "embedding,retrieval_text",
          highlight_full_fields: "content,retrieval_text",
        })
        if (semantic) {
          params.set("vector_query", `embedding:([], k:${Math.max(limit * 3, 20)}, alpha:0.75)`)
        }
        if (filters.length > 0) {
          params.set("filter_by", filters.join(" && "))
        }

        const result = yield* Effect.promise(() =>
          typesenseSearch(apiKey, DOCS_CHUNKS_COLLECTION, params)
        )

        const hits = (result.hits ?? [])
          .map((hit) => {
            const chunk = hit.document ? normalizeChunk(hit.document) : null
            if (!chunk) return null
            return {
              id: chunk.id,
              docId: chunk.docId,
              title: chunk.title,
              chunkType: chunk.chunkType,
              chunkIndex: chunk.chunkIndex,
              contextPrefix: chunk.contextPrefix,
              primaryConceptId: chunk.primaryConceptId,
              conceptIds: chunk.conceptIds,
              score: scoreFromHit(hit),
              snippet: firstSnippet(hit) ?? (chunk.content ?? "").slice(0, 280),
            }
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry != null)

        yield* Console.log(
          respond("docs search", {
            query,
            semantic,
            found: result.found ?? 0,
            hits,
            filters: {
              category: categoryValue,
              concept: conceptValue,
              chunkType: chunkTypeValue,
              docId: docIdValue,
            },
          }, [
            {
              command: "joelclaw docs context <chunk-id> --mode snippet-window",
              description: "Expand a hit into local context",
              params: {
                "chunk-id": { required: true, value: hits[0]?.id, description: "Chunk ID from hit list" },
              },
            },
            {
              command: "joelclaw docs search <query> --semantic false",
              description: "Run lexical-only fallback",
              params: {
                query: { required: true, value: query, description: "Query string" },
              },
            },
            {
              command: "joelclaw docs list [--category <category>]",
              description: "Inspect docs inventory by category",
              params: {
                category: { value: categoryValue ?? "", description: "Storage category filter" },
              },
            },
          ])
        )
      } catch (error: unknown) {
        if (isTypesenseApiKeyError(error)) {
          yield* Console.log(respondError(
            "docs search",
            error.message,
            error.code,
            error.fix,
            [
              { command: "joelclaw status", description: "Check system status" },
              { command: "joelclaw docs status", description: "Inspect docs collections health" },
            ]
          ))
          return
        }

        const message = error instanceof Error ? error.message : String(error)
        yield* Console.log(respondError(
          "docs search",
          message,
          "DOCS_SEARCH_FAILED",
          "Verify Typesense connectivity and docs collections",
          [
            { command: "joelclaw docs status", description: "Check docs stats and facets" },
            { command: "joelclaw otel search \"docs.\" --hours 1", description: "Inspect docs OTEL events" },
          ]
        ))
      }
    })
)

const contextCmd = Command.make(
  "context",
  {
    chunkId: Args.text({ name: "chunk-id" }),
    mode: Options.text("mode").pipe(Options.withDefault("snippet-window")),
    before: Options.integer("before").pipe(Options.withDefault(2)),
    after: Options.integer("after").pipe(Options.withDefault(2)),
    neighbors: Options.integer("neighbors").pipe(Options.withDefault(1)),
  },
  ({ chunkId, mode, before, after, neighbors }) =>
    Effect.gen(function* () {
      try {
        const apiKey = resolveTypesenseApiKey()
        const chunk = yield* Effect.promise(() => getChunkById(apiKey, chunkId))
        if (!chunk) {
          yield* Console.log(respondError(
            "docs context",
            `Chunk not found: ${chunkId}`,
            "DOCS_CHUNK_NOT_FOUND",
            "Use a chunk id returned by `joelclaw docs search`",
            [
              { command: "joelclaw docs search <query>", description: "Find chunk IDs first", params: { query: { required: true } } },
            ]
          ))
          return
        }

        const resolvedMode =
          mode === "snippet-window" || mode === "parent-section" || mode === "section-neighborhood"
            ? mode
            : "snippet-window"

        if (resolvedMode === "snippet-window") {
          const baseSnippet =
            chunk.chunkType === "snippet"
              ? chunk
              : (() => {
                  throw new Error("snippet-window mode requires a snippet chunk id")
                })()

          const snippets = yield* Effect.promise(() =>
            collectSnippetWindow(apiKey, baseSnippet, Math.max(0, before), Math.max(0, after))
          )
          const parent = yield* Effect.promise(() => resolveParentSection(apiKey, baseSnippet))
          const text = snippets.map(renderChunkText).join("\n\n")

          yield* Console.log(respond("docs context", {
            mode: resolvedMode,
            chunkId,
            docId: chunk.docId,
            section: parent,
            snippets,
            text,
          }, [
            {
              command: "joelclaw docs context <chunk-id> --mode parent-section",
              description: "Expand to full parent section",
              params: { "chunk-id": { required: true, value: chunkId } },
            },
            {
              command: "joelclaw docs context <chunk-id> --mode section-neighborhood",
              description: "Expand to neighboring sections",
              params: { "chunk-id": { required: true, value: chunkId } },
            },
          ]))
          return
        }

        if (resolvedMode === "parent-section") {
          const parent = yield* Effect.promise(() => resolveParentSection(apiKey, chunk))
          const snippets = yield* Effect.promise(() =>
            fetchSnippetsForParentSection(apiKey, parent.id)
          )
          const text = snippets.length > 0
            ? snippets.map(renderChunkText).join("\n\n")
            : renderChunkText(parent)

          yield* Console.log(respond("docs context", {
            mode: resolvedMode,
            chunkId,
            docId: chunk.docId,
            section: parent,
            snippets,
            text,
          }, [
            {
              command: "joelclaw docs context <chunk-id> --mode section-neighborhood",
              description: "Expand to neighboring sections",
              params: { "chunk-id": { required: true, value: chunkId } },
            },
            {
              command: "joelclaw docs search <query>",
              description: "Return to snippet-first search",
              params: { query: { required: true } },
            },
          ]))
          return
        }

        const parent = yield* Effect.promise(() => resolveParentSection(apiKey, chunk))
        const sections = yield* Effect.promise(() =>
          collectNeighborSections(apiKey, parent, Math.max(0, neighbors))
        )
        const snippets = yield* Effect.promise(() =>
          fetchSnippetsForSections(apiKey, sections.map((section) => section.id))
        )
        const text = sections.map(renderChunkText).join("\n\n")

        yield* Console.log(respond("docs context", {
          mode: resolvedMode,
          chunkId,
          docId: chunk.docId,
          sections,
          snippets,
          text,
        }, [
          {
            command: "joelclaw docs context <chunk-id> --mode parent-section",
            description: "Narrow to only the parent section",
            params: { "chunk-id": { required: true, value: chunkId } },
          },
          {
            command: "joelclaw docs search <query>",
            description: "Run another snippet-first query",
            params: { query: { required: true } },
          },
        ]))
      } catch (error: unknown) {
        if (isTypesenseApiKeyError(error)) {
          yield* Console.log(respondError(
            "docs context",
            error.message,
            error.code,
            error.fix,
            [
              { command: "joelclaw docs status", description: "Inspect docs index health" },
            ]
          ))
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        yield* Console.log(respondError(
          "docs context",
          message,
          "DOCS_CONTEXT_FAILED",
          "Verify chunk id exists and mode is valid",
          [
            {
              command: "joelclaw docs search <query>",
              description: "Find a valid snippet chunk id",
              params: { query: { required: true } },
            },
          ]
        ))
      }
    })
)

const addCmd = Command.make(
  "add",
  {
    path: Args.text({ name: "path" }),
    title: Options.text("title").pipe(Options.optional),
    tags: Options.text("tags").pipe(Options.optional),
    category: Options.text("category").pipe(Options.optional),
  },
  ({ path, title, tags, category }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const payload: Record<string, unknown> = {
        nasPath: path,
      }
      if (title._tag === "Some" && title.value.trim().length > 0) {
        payload.title = title.value.trim()
      }
      if (tags._tag === "Some") {
        payload.tags = parseTagsCsv(tags.value)
      }
      if (category._tag === "Some" && category.value.trim().length > 0) {
        payload.storageCategory = category.value.trim()
      }

      const response = yield* inngestClient.send("docs/ingest.requested", payload)
      const runIds = (response as { ids?: string[] })?.ids ?? []

      yield* Console.log(respond("docs add", {
        event: "docs/ingest.requested",
        data: payload,
        response,
      }, [
        {
          command: "joelclaw run <run-id>",
          description: "Inspect ingest run details",
          params: {
            "run-id": { required: true, value: runIds[0] ?? "RUN_ID" },
          },
        },
        { command: "joelclaw otel search \"docs.\" --hours 1", description: "Check docs ingest telemetry" },
        { command: "joelclaw docs status", description: "Verify docs and chunks counts" },
      ]))
    })
)

const listCmd = Command.make(
  "list",
  {
    limit: Options.integer("limit").pipe(Options.withAlias("n"), Options.withDefault(DEFAULT_LIST_LIMIT)),
    category: Options.text("category").pipe(Options.optional),
  },
  ({ limit, category }) =>
    Effect.gen(function* () {
      try {
        const apiKey = resolveTypesenseApiKey()
        const categoryValue = category._tag === "Some" ? category.value.trim() : undefined

        const params = new URLSearchParams({
          q: "*",
          query_by: "title",
          per_page: String(limit),
          sort_by: "added_at:desc",
          include_fields: "id,title,filename,nas_path,storage_category,document_type,file_type,tags,primary_concept_id,concept_ids,taxonomy_version,added_at,size_bytes",
          exclude_fields: "embedding",
        })
        if (categoryValue) {
          params.set("filter_by", `storage_category:=${quoteFilterValue(categoryValue)}`)
        }

        const result = yield* Effect.promise(() => typesenseSearch(apiKey, DOCS_COLLECTION, params))
        const docs = (result.hits ?? [])
          .map((hit) => (hit.document ? normalizeDocument(hit.document) : null))
          .filter((doc): doc is DocsDocument => doc != null)

        yield* Console.log(respond("docs list", {
          found: result.found ?? docs.length,
          returned: docs.length,
          category: categoryValue,
          docs,
        }, [
          {
            command: "joelclaw docs show <doc-id>",
            description: "Inspect one document with chunk stats",
            params: { "doc-id": { required: true, value: docs[0]?.id } },
          },
          { command: "joelclaw docs status", description: "Collection-wide docs metrics" },
          { command: "joelclaw docs search <query>", description: "Search chunk evidence", params: { query: { required: true } } },
        ]))
      } catch (error: unknown) {
        if (isTypesenseApiKeyError(error)) {
          yield* Console.log(respondError(
            "docs list",
            error.message,
            error.code,
            error.fix,
            [{ command: "joelclaw status", description: "Check system status" }]
          ))
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        yield* Console.log(respondError(
          "docs list",
          message,
          "DOCS_LIST_FAILED",
          "Verify Typesense docs collection",
          [{ command: "joelclaw docs status", description: "Inspect docs stats and facets" }]
        ))
      }
    })
)

const showCmd = Command.make(
  "show",
  {
    docId: Args.text({ name: "doc-id" }),
  },
  ({ docId }) =>
    Effect.gen(function* () {
      try {
        const apiKey = resolveTypesenseApiKey()
        const doc = yield* Effect.promise(() => getDocById(apiKey, docId))
        if (!doc) {
          yield* Console.log(respondError(
            "docs show",
            `Document not found: ${docId}`,
            "DOC_NOT_FOUND",
            "Use `joelclaw docs list` to find valid IDs",
            [{ command: "joelclaw docs list", description: "List indexed documents" }]
          ))
          return
        }

        const statsParams = new URLSearchParams({
          q: "*",
          query_by: "content",
          per_page: "3",
          sort_by: "chunk_index:asc",
          filter_by: `doc_id:=${quoteFilterValue(docId)}`,
          facet_by: "chunk_type,evidence_tier",
          include_fields: "id,chunk_type,chunk_index,context_prefix,parent_chunk_id,evidence_tier,content",
          exclude_fields: "embedding,retrieval_text",
        })
        const chunkStats = yield* Effect.promise(() =>
          typesenseSearch(apiKey, DOCS_CHUNKS_COLLECTION, statsParams)
        )

        const sampleChunks = (chunkStats.hits ?? [])
          .map((hit) => (hit.document ? normalizeChunk(hit.document) : null))
          .filter((chunk): chunk is DocsChunk => chunk != null)

        yield* Console.log(respond("docs show", {
          doc,
          chunkCount: chunkStats.found ?? 0,
          facets: chunkStats.facet_counts ?? [],
          sampleChunks,
        }, [
          {
            command: "joelclaw docs context <chunk-id> --mode snippet-window",
            description: "Expand a sample chunk",
            params: {
              "chunk-id": { required: true, value: sampleChunks[0]?.id },
            },
          },
          {
            command: "joelclaw docs enrich <doc-id>",
            description: "Requeue enrichment for this document",
            params: { "doc-id": { required: true, value: docId } },
          },
          {
            command: "joelclaw docs reindex --doc <doc-id>",
            description: "Requeue full reindex for this document",
            params: { "doc-id": { required: true, value: docId } },
          },
        ]))
      } catch (error: unknown) {
        if (isTypesenseApiKeyError(error)) {
          yield* Console.log(respondError(
            "docs show",
            error.message,
            error.code,
            error.fix,
            [{ command: "joelclaw docs status", description: "Check docs index health" }]
          ))
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        yield* Console.log(respondError(
          "docs show",
          message,
          "DOCS_SHOW_FAILED",
          "Verify the doc id and docs collections",
          [{ command: "joelclaw docs list", description: "List available docs" }]
        ))
      }
    })
)

const statusCmd = Command.make(
  "status",
  {},
  () =>
    Effect.gen(function* () {
      try {
        const apiKey = resolveTypesenseApiKey()

        const docsParams = new URLSearchParams({
          q: "*",
          query_by: "title",
          per_page: "1",
          facet_by: "storage_category,document_type,file_type,taxonomy_version,concept_source",
          max_facet_values: "25",
          exclude_fields: "embedding",
        })
        const chunksParams = new URLSearchParams({
          q: "*",
          query_by: "content",
          per_page: "1",
          facet_by: "chunk_type,evidence_tier,taxonomy_version,concept_source",
          max_facet_values: "25",
          exclude_fields: "embedding,retrieval_text",
        })

        const [docsResult, chunksResult] = yield* Effect.promise(() =>
          Promise.all([
            typesenseSearch(apiKey, DOCS_COLLECTION, docsParams),
            typesenseSearch(apiKey, DOCS_CHUNKS_COLLECTION, chunksParams),
          ])
        )

        const ok = (docsResult.found ?? 0) > 0 && (chunksResult.found ?? 0) > 0

        yield* Console.log(respond("docs status", {
          collections: {
            docs: {
              found: docsResult.found ?? 0,
              facets: docsResult.facet_counts ?? [],
            },
            docs_chunks: {
              found: chunksResult.found ?? 0,
              facets: chunksResult.facet_counts ?? [],
            },
          },
        }, [
          { command: "joelclaw docs list --limit 10", description: "Inspect latest indexed docs" },
          { command: "joelclaw docs search <query>", description: "Run retrieval query", params: { query: { required: true } } },
          { command: "joelclaw otel search \"docs.\" --hours 1", description: "Inspect docs OTEL events" },
        ], ok))
      } catch (error: unknown) {
        if (isTypesenseApiKeyError(error)) {
          yield* Console.log(respondError(
            "docs status",
            error.message,
            error.code,
            error.fix,
            [{ command: "joelclaw status", description: "Check system health" }]
          ))
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        yield* Console.log(respondError(
          "docs status",
          message,
          "DOCS_STATUS_FAILED",
          "Verify Typesense and docs collections",
          [{ command: "joelclaw status", description: "Check overall service health" }]
        ))
      }
    })
)

const enrichCmd = Command.make(
  "enrich",
  {
    docId: Args.text({ name: "doc-id" }),
  },
  ({ docId }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const response = yield* inngestClient.send("docs/enrich.requested", { docId })
      const runIds = (response as { ids?: string[] })?.ids ?? []

      yield* Console.log(respond("docs enrich", {
        event: "docs/enrich.requested",
        data: { docId },
        response,
      }, [
        {
          command: "joelclaw run <run-id>",
          description: "Inspect enrich run details",
          params: { "run-id": { required: true, value: runIds[0] ?? "RUN_ID" } },
        },
        {
          command: "joelclaw otel search \"docs.enrich\" --hours 1",
          description: "Check enrich OTEL telemetry",
        },
      ]))
    })
)

const reindexCmd = Command.make(
  "reindex",
  {
    docId: Options.text("doc").pipe(Options.optional),
  },
  ({ docId }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const payload: Record<string, unknown> = {}
      if (docId._tag === "Some" && docId.value.trim().length > 0) {
        payload.docId = docId.value.trim()
      }
      const response = yield* inngestClient.send("docs/reindex.requested", payload)
      const runIds = (response as { ids?: string[] })?.ids ?? []

      yield* Console.log(respond("docs reindex", {
        event: "docs/reindex.requested",
        data: payload,
        response,
      }, [
        {
          command: "joelclaw run <run-id>",
          description: "Inspect reindex run details",
          params: { "run-id": { required: true, value: runIds[0] ?? "RUN_ID" } },
        },
        {
          command: "joelclaw otel search \"docs.reindex\" --hours 1",
          description: "Check reindex OTEL telemetry",
        },
      ]))
    })
)

export const docsCmd = Command.make(
  "docs",
  {},
  () =>
    Console.log(respond("docs", {
      description: "Docs brain commands: ingest, retrieval, context expansion, maintenance",
      subcommands: {
        add: "joelclaw docs add <path> [--title <title>] [--tags a,b,c] [--category <storage-category>]",
        search: "joelclaw docs search <query> [--limit N] [--category <category>] [--concept <concept-id>] [--chunk-type <section|snippet>] [--doc <doc-id>]",
        context: "joelclaw docs context <chunk-id> [--mode snippet-window|parent-section|section-neighborhood]",
        list: "joelclaw docs list [--category <category>] [--limit N]",
        show: "joelclaw docs show <doc-id>",
        status: "joelclaw docs status",
        enrich: "joelclaw docs enrich <doc-id>",
        reindex: "joelclaw docs reindex [--doc <doc-id>]",
      },
      modes: ["snippet-window", "parent-section", "section-neighborhood"],
    }, [
      { command: "joelclaw docs status", description: "Verify docs collections and facets" },
      { command: "joelclaw docs search <query>", description: "Run snippet-first retrieval", params: { query: { required: true } } },
      { command: "joelclaw docs list --limit 10", description: "Inspect indexed docs" },
      { command: "joelclaw docs add <path>", description: "Queue ingest for a file path", params: { path: { required: true } } },
    ]))
).pipe(
  Command.withSubcommands([
    addCmd,
    searchCmd,
    contextCmd,
    listCmd,
    showCmd,
    statusCmd,
    enrichCmd,
    reindexCmd,
  ])
)
