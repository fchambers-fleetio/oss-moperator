import { getPrograms } from "./client"

type LatestProgramFilters = {
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

export function detectLatestMarketoProgramIntent(text: string): LatestProgramFilters | null {
  const lower = text.toLowerCase()

  if (!lower.includes("marketo")) {
    return null
  }

  const asksForLatest =
    lower.includes("most recent") ||
    lower.includes("latest") ||
    lower.includes("newest")

  const asksForCreated =
    lower.includes("created") ||
    lower.includes("created at")

  const asksForProgram =
    lower.includes("program") ||
    lower.includes("email program")

  if (!asksForLatest || !asksForCreated || !asksForProgram) {
    return null
  }

  const filters: LatestProgramFilters = {}

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

export async function answerLatestMarketoProgramQuestion(
  text: string
): Promise<string | null> {
  if (!isMarketoConfigured()) {
    return null
  }

  const filters = detectLatestMarketoProgramIntent(text)
  if (!filters) {
    return null
  }

  const response = await getPrograms(1, filters)
  const result = Array.isArray(response.result) ? response.result[0] : null

  if (!result || typeof result !== "object") {
    return "I couldn't find a matching Marketo program."
  }

  const program = result as Record<string, unknown>
  const url = typeof program.url === "string" ? program.url : null
  const lines = [
    "*Most Recent Marketo Program Created:*",
    `- Name: ${String(program.name ?? "Unknown")}`,
    `- Created At: ${formatDate(program.createdAt)}`,
    `- Type: ${String(program.type ?? "Unknown")}`,
    `- Channel: ${String(program.channel ?? "Unknown")}`,
  ]

  if (program.status) {
    lines.push(`- Status: ${String(program.status)}`)
  }

  if (url) {
    lines.push(`- URL: ${url}`)
  }

  return lines.join("\n")
}
