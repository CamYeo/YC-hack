// Minimal structured logger. Redacts secrets before anything reaches stdout/stderr.
// Use this instead of console.* in server code.

type Level = "debug" | "info" | "warn" | "error"

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const minLevel: Level = process.argv.includes("--debug") ? "debug" : "info"

const SECRET_PATTERNS: RegExp[] = [
    /(authorization|xi-api-key|api[-_]?key|token|secret)(["'\s:=]+)(Bearer\s+)?[A-Za-z0-9._~+/=-]{8,}/gi,
    /\b(sk-[A-Za-z0-9_-]{10,}|ar_ws_[A-Za-z0-9_-]+|ar_ag_[A-Za-z0-9_-]+|rk_live_[A-Za-z0-9_-]+|at_live_[A-Za-z0-9_-]+|nt_live_[A-Za-z0-9_-]+|ot_live_[A-Za-z0-9_-]+|sutkn_[A-Za-z0-9_-]+)\b/g,
    /([?&](token|key|roomToken|api_key)=)[^&\s"']+/gi,
]

/** Remove credentials, bearer tokens and token-bearing query strings from a string. */
export function redact(input: string): string {
    let output = input
    output = output.replace(SECRET_PATTERNS[0] as RegExp, (_m, name: string, sep: string, bearer: string | undefined) => `${name}${sep}${bearer ?? ""}[redacted]`)
    output = output.replace(SECRET_PATTERNS[1] as RegExp, "[redacted]")
    output = output.replace(SECRET_PATTERNS[2] as RegExp, (_m, prefix: string) => `${prefix}[redacted]`)
    return output
}

function format(level: Level, scope: string, message: string, fields?: Record<string, unknown>): string {
    const time = new Date().toISOString().slice(11, 23)
    const extra = fields === undefined ? "" : ` ${safeJson(fields)}`
    return redact(`${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${extra}`)
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value, (_key, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message } : v))
    } catch {
        return "[unserializable]"
    }
}

export interface Logger {
    debug(message: string, fields?: Record<string, unknown>): void
    info(message: string, fields?: Record<string, unknown>): void
    warn(message: string, fields?: Record<string, unknown>): void
    error(message: string, fields?: Record<string, unknown>): void
    child(scope: string): Logger
}

export function createLogger(scope: string): Logger {
    const write = (level: Level, message: string, fields?: Record<string, unknown>): void => {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
        const line = `${format(level, scope, message, fields)}\n`
        if (process.argv.includes("--stdio") || level === "warn" || level === "error") process.stderr.write(line)
        else process.stdout.write(line)
    }
    return {
        debug: (m, f) => write("debug", m, f),
        info: (m, f) => write("info", m, f),
        warn: (m, f) => write("warn", m, f),
        error: (m, f) => write("error", m, f),
        child: (child) => createLogger(`${scope}:${child}`),
    }
}

/** A logger that discards everything (tests). */
export const silentLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silentLogger,
}
