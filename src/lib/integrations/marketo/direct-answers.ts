import {
  getCampaigns,
  getEmails,
  getLeads,
  getLists,
  getPrograms,
} from "./client"

type ProgramFilters = {
  channel?: string
  type?: string
}

function isMarketoConfigured(): boolean {
  return !!(
    process.env.MARKETO_CLIENT_ID &&
    process.env.MARKETO_CLIENT_SECRET &&
    process.env.MARKETO_REST_ENDPOINT
  )
}

function isMarketoDirectDebugEnabled(): boolean {
  return process.env.MARKETO_DEBUG === "true"
}

function logMarketoDirectDebug(message: string, payload?: unknown) {
  if (!isMarketoDirectDebugEnabled()) {
    return
  }

  if (payload === undefined) {
    console.log(`[Marketo Direct] ${message}`)
    return
  }

  console.log(`[Marketo Direct] ${message}`, JSON.stringify(payload, null, 2))
}

function formatDate(value: unknown): string {
  if (typeof value !== "string") {
    return "Unknown"
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return parsed.toLocaleString("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "America/Chicago",
  })
}

function parseLimit(text: string, fallback = 10): number {
  const match = text.match(/\b(?:top|latest|last|show|list)\s+(\d{1,3})\b/i)
  if (!match) {
    return fallback
  }

  const value = Number.parseInt(match[1], 10)
  if (Number.isNaN(value)) {
    return fallback
  }

  return Math.max(1, Math.min(value, 25))
}

function parseProgramFilters(text: string): ProgramFilters {
  const lower = text.toLowerCase()
  const filters: ProgramFilters = {}

  if (lower.includes("email program")) {
    filters.type = "Email"
  }

  if (lower.includes("newsletter")) {
    filters.channel = "Newsletter"
  } else if (lower.includes("email blast")) {
    filters.channel = "Email Blast"
  } else if (lower.includes("email send")) {
    filters.channel = "Email Send"
  } else if (lower.includes("webinar")) {
    filters.channel = "Webinar"
  }

  return filters
}

function looksLikeMarketoWriteIntent(text: string): boolean {
  return /\b(create|update|delete|remove|add|trigger)\b/i.test(text)
}

function extractEmail(text: string): string | null {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return match ? match[0] : null
}

function formatProgram(program: Record<string, unknown>, includeCreatedAt = true): string {
  const lines = [`- Name: ${String(program.name ?? "Unknown")}`]

  if (includeCreatedAt) {
    lines.push(`  Created At: ${formatDate(program.createdAt)}`)
  }

  lines.push(`  Type: ${String(program.type ?? "Unknown")}`)
  lines.push(`  Channel: ${String(program.channel ?? "Unknown")}`)

  if (program.status) {
    lines.push(`  Status: ${String(program.status)}`)
  }

  if (typeof program.url === "string") {
    lines.push(`  URL: ${program.url}`)
  }

  return lines.join("\n")
}

function formatSimpleAsset(
  asset: Record<string, unknown>,
  kind: "Email" | "List" | "Campaign"
): string {
  const lines = [`- ${kind}: ${String(asset.name ?? "Unknown")}`]

  if (asset.createdAt) {
    lines.push(`  Created At: ${formatDate(asset.createdAt)}`)
  }

  if (typeof asset.url === "string") {
    lines.push(`  URL: ${asset.url}`)
  }

  return lines.join("\n")
}

async function answerLatestProgramQuestion(text: string): Promise<string | null> {
  const lower = text.toLowerCase()
  const asksForLatest =
    lower.includes("most recent") || lower.includes("latest") || lower.includes("newest")
  const asksForCreated = lower.includes("created")
  const asksForProgram = lower.includes("program")

  if (!asksForLatest || !asksForCreated || !asksForProgram) {
    return null
  }

  const filters = parseProgramFilters(text)
  logMarketoDirectDebug("Latest program intent detected", { text, filters })

  const response = await getPrograms(1, filters)
  const result = Array.isArray(response.result) ? response.result[0] : null

  if (!result || typeof result !== "object") {
    logMarketoDirectDebug("Latest program query returned no match")
    return "I couldn't find a matching Marketo program."
  }

  logMarketoDirectDebug("Latest program selected", result)

  return ["*Most Recent Marketo Program Created:*", formatProgram(result as Record<string, unknown>)].join("\n")
}

async function answerProgramListQuestion(text: string): Promise<string | null> {
  const lower = text.toLowerCase()

  if (!lower.includes("program")) {
    return null
  }

  if (!/\b(list|show|what are|which are|give me|recent)\b/i.test(text)) {
    return null
  }

  const limit = parseLimit(text)
  const response = await getPrograms(limit, parseProgramFilters(text))
  const results = Array.isArray(response.result) ? response.result : []

  if (results.length === 0) {
    return "I couldn't find any matching Marketo programs."
  }

  return [
    `*Marketo Programs (${results.length} shown):*`,
    ...results.map((result) => formatProgram(result as Record<string, unknown>)),
  ].join("\n")
}

async function answerEmailAssetQuestion(text: string): Promise<string | null> {
  const lower = text.toLowerCase()

  if (!lower.includes("marketo")) {
    return null
  }

  const asksForEmailAssets =
    lower.includes("email asset") ||
    (lower.includes("emails") && !lower.includes("email program")) ||
    lower.includes("email assets")

  if (!asksForEmailAssets || !/\b(list|show|what are|which are|give me|recent)\b/i.test(text)) {
    return null
  }

  const limit = parseLimit(text)
  const response = await getEmails(limit)
  const results = Array.isArray(response.result) ? response.result : []

  if (results.length === 0) {
    return "I couldn't find any Marketo email assets."
  }

  return [
    `*Marketo Email Assets (${results.length} shown):*`,
    ...results.map((result) => formatSimpleAsset(result as Record<string, unknown>, "Email")),
  ].join("\n")
}

async function answerListQuestion(text: string): Promise<string | null> {
  const lower = text.toLowerCase()

  if (!lower.includes("list")) {
    return null
  }

  if (!/\b(list|show|what are|which are|give me|recent)\b/i.test(text)) {
    return null
  }

  const limit = parseLimit(text)
  const response = await getLists(limit)
  const results = Array.isArray(response.result) ? response.result : []

  if (results.length === 0) {
    return "I couldn't find any Marketo lists."
  }

  return [
    `*Marketo Lists (${results.length} shown):*`,
    ...results.map((result) => formatSimpleAsset(result as Record<string, unknown>, "List")),
  ].join("\n")
}

async function answerCampaignQuestion(text: string): Promise<string | null> {
  const lower = text.toLowerCase()

  if (!lower.includes("campaign")) {
    return null
  }

  if (!/\b(list|show|what are|which are|give me)\b/i.test(text)) {
    return null
  }

  const response = await getCampaigns()
  const results =
    response && typeof response === "object" && "result" in response && Array.isArray(response.result)
      ? response.result
      : []
  const limit = parseLimit(text)
  const sliced = results.slice(0, limit)

  if (sliced.length === 0) {
    return "I couldn't find any Marketo campaigns."
  }

  return [
    `*Marketo Campaigns (${sliced.length} shown):*`,
    ...sliced.map((result) => formatSimpleAsset(result as Record<string, unknown>, "Campaign")),
  ].join("\n")
}

async function answerLeadLookupQuestion(text: string): Promise<string | null> {
  const lower = text.toLowerCase()
  const email = extractEmail(text)

  if (!email) {
    return null
  }

  if (!lower.includes("lead") && !lower.includes("person") && !lower.includes("contact")) {
    return null
  }

  const response = await getLeads("email", [email], 5)
  const results = Array.isArray(response.result) ? response.result : []

  if (results.length === 0) {
    return `I couldn't find a Marketo lead for ${email}.`
  }

  return [
    `*Marketo Leads Matching ${email}:*`,
    ...results.map((result) => {
      const lead = result as Record<string, unknown>
      return [
        `- ID: ${String(lead.id ?? "Unknown")}`,
        `  Email: ${String(lead.email ?? email)}`,
        `  Name: ${String([lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Unknown")}`,
        `  Company: ${String(lead.company ?? "Unknown")}`,
        `  Updated At: ${formatDate(lead.updatedAt)}`,
      ].join("\n")
    }),
  ].join("\n")
}

export async function answerDirectMarketoQuestion(text: string): Promise<string | null> {
  if (!isMarketoConfigured()) {
    return null
  }

  if (!text.toLowerCase().includes("marketo")) {
    return null
  }

  if (looksLikeMarketoWriteIntent(text)) {
    logMarketoDirectDebug("Skipping direct Marketo answer because write intent was detected", { text })
    return null
  }

  const answer = (
    (await answerLatestProgramQuestion(text)) ??
    (await answerLeadLookupQuestion(text)) ??
    (await answerProgramListQuestion(text)) ??
    (await answerEmailAssetQuestion(text)) ??
    (await answerListQuestion(text)) ??
    (await answerCampaignQuestion(text))
  )

  if (answer) {
    logMarketoDirectDebug("Direct Marketo answer produced a response")
  } else {
    logMarketoDirectDebug("No direct Marketo handler matched", { text })
  }

  return answer
}
