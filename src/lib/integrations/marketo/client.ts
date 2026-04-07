/**
 * Marketo REST API Client
 *
 * Uses OAuth 2.0 client credentials for authentication with auto-refresh.
 * Requires MARKETO_CLIENT_ID, MARKETO_CLIENT_SECRET, MARKETO_REST_ENDPOINT.
 */

let _accessToken: string | null = null
let _tokenExpiresAt = 0

const MARKETO_LEAD_BATCH_SIZE = 300
const MARKETO_ASSET_PAGE_SIZE = 200
const MARKETO_DEFAULT_RESULT_LIMIT = 25
const MARKETO_LIST_MEMBER_RESULT_LIMIT = 100

type MarketoResponse = {
  errors?: unknown[]
  moreResult?: boolean
  nextPageToken?: string
  requestId?: string
  result?: unknown[]
  success: boolean
  warnings?: unknown[]
}

function isMarketoDebugEnabled(): boolean {
  return process.env.MARKETO_DEBUG === "true"
}

function logMarketoDebug(message: string, payload?: unknown) {
  if (!isMarketoDebugEnabled()) {
    return
  }

  if (payload === undefined) {
    console.log(`[Marketo Debug] ${message}`)
    return
  }

  console.log(`[Marketo Debug] ${message}`, JSON.stringify(payload, null, 2))
}

function getSortableTimestamp(value: unknown): number {
  if (!value || typeof value !== "object") {
    return Number.NEGATIVE_INFINITY
  }

  const updatedAt = "updatedAt" in value ? Date.parse(String(value.updatedAt)) : Number.NaN
  if (!Number.isNaN(updatedAt)) {
    return updatedAt
  }

  const createdAt = "createdAt" in value ? Date.parse(String(value.createdAt)) : Number.NaN
  if (!Number.isNaN(createdAt)) {
    return createdAt
  }

  return Number.NEGATIVE_INFINITY
}

function sortNewestFirst(results: unknown[]): unknown[] {
  return [...results].sort(
    (a, b) => getSortableTimestamp(b) - getSortableTimestamp(a)
  )
}

function truncateResults(
  response: MarketoResponse,
  limit: number
): MarketoResponse {
  if (!Array.isArray(response.result)) {
    return response
  }

  return {
    ...response,
    result: response.result.slice(0, limit),
  }
}

function getConfig() {
  const clientId = process.env.MARKETO_CLIENT_ID
  const clientSecret = process.env.MARKETO_CLIENT_SECRET
  const restEndpoint = process.env.MARKETO_REST_ENDPOINT

  if (!clientId || !clientSecret || !restEndpoint) {
    throw new Error(
      "Marketo not configured. Set MARKETO_CLIENT_ID, MARKETO_CLIENT_SECRET, and MARKETO_REST_ENDPOINT."
    )
  }

  // Strip trailing slash
  const baseUrl = restEndpoint.replace(/\/+$/, "")

  return { clientId, clientSecret, baseUrl }
}

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (_accessToken && Date.now() < _tokenExpiresAt - 60_000) {
    return _accessToken
  }

  const { clientId, clientSecret, baseUrl } = getConfig()

  const res = await fetch(
    `${baseUrl}/identity/oauth/token?grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
    { method: "POST" }
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Marketo auth error ${res.status}: ${body}`)
  }

  const data = (await res.json()) as {
    access_token: string
    expires_in: number
  }

  _accessToken = data.access_token
  _tokenExpiresAt = Date.now() + data.expires_in * 1000

  return _accessToken
}

async function marketoFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getAccessToken()
  const { baseUrl } = getConfig()

  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Marketo API error ${res.status}: ${body}`)
  }

  const data = await res.json()
  logMarketoDebug(`Response for ${path}`, data)
  return data as T
}

function appendQuery(path: string, params: URLSearchParams): string {
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

async function marketoFetchAllLeadPages(
  path: string,
  params: URLSearchParams
): Promise<MarketoResponse> {
  const results: unknown[] = []
  let nextPageToken: string | undefined
  let pageNumber = 1

  while (true) {
    const pageParams = new URLSearchParams(params)
    pageParams.set("batchSize", String(MARKETO_LEAD_BATCH_SIZE))

    if (nextPageToken) {
      pageParams.set("nextPageToken", nextPageToken)
    }

    const page = await marketoFetch<MarketoResponse>(appendQuery(path, pageParams))
    logMarketoDebug(`Lead page ${pageNumber} summary for ${path}`, {
      batchSize: pageParams.get("batchSize"),
      nextPageTokenUsed: pageParams.get("nextPageToken"),
      returned: Array.isArray(page.result) ? page.result.length : 0,
      moreResult: page.moreResult,
      nextPageToken: page.nextPageToken,
    })

    if (Array.isArray(page.result)) {
      results.push(...page.result)
    }

    if (!page.moreResult || !page.nextPageToken) {
      return {
        ...page,
        nextPageToken: undefined,
        moreResult: false,
        result: sortNewestFirst(results),
      }
    }

    nextPageToken = page.nextPageToken
    pageNumber += 1
  }
}

async function marketoFetchAllAssetPages(
  path: string,
  params: URLSearchParams = new URLSearchParams()
): Promise<MarketoResponse> {
  const results: unknown[] = []
  let offset = 0
  let pageNumber = 1

  while (true) {
    const pageParams = new URLSearchParams(params)
    pageParams.set("offset", String(offset))
    pageParams.set("maxReturn", String(MARKETO_ASSET_PAGE_SIZE))

    const page = await marketoFetch<MarketoResponse>(appendQuery(path, pageParams))
    const pageResults = Array.isArray(page.result) ? page.result : []
    logMarketoDebug(`Asset page ${pageNumber} summary for ${path}`, {
      maxReturn: pageParams.get("maxReturn"),
      offset,
      returned: pageResults.length,
    })

    results.push(...pageResults)

    if (pageResults.length < MARKETO_ASSET_PAGE_SIZE) {
      return {
        ...page,
        result: sortNewestFirst(results),
      }
    }

    offset += pageResults.length
    pageNumber += 1
  }
}

// ─── Leads ────────────────────────────────────────────────────────────────────

export async function getLeads(
  filterType: string,
  filterValues: string[],
  limit = MARKETO_DEFAULT_RESULT_LIMIT
): Promise<MarketoResponse> {
  const params = new URLSearchParams({
    filterType,
    filterValues: filterValues.join(","),
  })
  const response = await marketoFetchAllLeadPages("/rest/v1/leads.json", params)
  return truncateResults(response, limit)
}

export async function getLead(id: string): Promise<unknown> {
  return marketoFetch(`/rest/v1/lead/${id}.json`)
}

export async function createOrUpdateLeads(
  leads: Array<Record<string, unknown>>,
  action: "createOnly" | "updateOnly" | "createOrUpdate" = "createOrUpdate"
): Promise<unknown> {
  return marketoFetch("/rest/v1/leads.json", {
    method: "POST",
    body: JSON.stringify({
      action,
      input: leads,
    }),
  })
}

export async function deleteLead(id: string): Promise<unknown> {
  return marketoFetch("/rest/v1/leads/delete.json", {
    method: "POST",
    body: JSON.stringify({
      input: [{ id }],
    }),
  })
}

export async function describeLeads(): Promise<unknown> {
  return marketoFetch("/rest/v1/leads/describe.json")
}

// ─── Lists ────────────────────────────────────────────────────────────────────

export async function getLists(
  limit = MARKETO_DEFAULT_RESULT_LIMIT
): Promise<MarketoResponse> {
  const response = await marketoFetchAllAssetPages("/rest/v1/lists.json")
  return truncateResults(response, limit)
}

export async function getListLeads(
  listId: string,
  limit = MARKETO_LIST_MEMBER_RESULT_LIMIT
): Promise<MarketoResponse> {
  const response = await marketoFetchAllLeadPages(
    `/rest/v1/lists/${listId}/leads.json`,
    new URLSearchParams()
  )
  return truncateResults(response, limit)
}

export async function addLeadsToList(
  listId: string,
  leadIds: string[]
): Promise<unknown> {
  const params = new URLSearchParams({ id: leadIds.join(",") })
  return marketoFetch(`/rest/v1/lists/${listId}/leads.json?${params}`, {
    method: "POST",
  })
}

export async function removeLeadsFromList(
  listId: string,
  leadIds: string[]
): Promise<unknown> {
  const params = new URLSearchParams({ id: leadIds.join(",") })
  return marketoFetch(`/rest/v1/lists/${listId}/leads.json?${params}`, {
    method: "DELETE",
  })
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

export async function getCampaigns(): Promise<unknown> {
  return marketoFetch("/rest/v1/campaigns.json")
}

export async function triggerCampaign(
  campaignId: string,
  leadIds: string[],
  tokens?: Array<{ name: string; value: string }>
): Promise<unknown> {
  const body: Record<string, unknown> = {
    input: { leads: leadIds.map((id) => ({ id })) },
  }
  if (tokens) {
    body.input = {
      ...(body.input as Record<string, unknown>),
      tokens,
    }
  }
  return marketoFetch(`/rest/v1/campaigns/${campaignId}/trigger.json`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

// ─── Assets ───────────────────────────────────────────────────────────────────

export async function getPrograms(
  limit = MARKETO_DEFAULT_RESULT_LIMIT
): Promise<MarketoResponse> {
  const response = await marketoFetchAllAssetPages("/rest/asset/v1/programs.json")
  return truncateResults(response, limit)
}

export async function getEmails(
  limit = MARKETO_DEFAULT_RESULT_LIMIT
): Promise<MarketoResponse> {
  const response = await marketoFetchAllAssetPages("/rest/asset/v1/emails.json")
  return truncateResults(response, limit)
}

export async function getFolders(
  limit = MARKETO_DEFAULT_RESULT_LIMIT
): Promise<MarketoResponse> {
  const response = await marketoFetchAllAssetPages("/rest/asset/v1/folders.json")
  return truncateResults(response, limit)
}
