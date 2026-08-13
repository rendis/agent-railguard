export function redactSensitiveText(value: string): string {
  return value
    .replace(/Authorization\s*:\s*(?:Bearer|Basic)\s+[^\s]+/gi, "Authorization: [REDACTED]")
    .replace(/((?:Set-)?Cookie\s*:)[^\r\n]*/gi, "$1 [REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/([?&](?:code|token|access_token|refresh_token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/((?:access|refresh|api)[_-]?token\s*[=:]\s*)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:"|')?(?:access_token|refresh_token|api_token|token|code)(?:"|')?\s*:\s*(?:"|'))[^"'\r\n]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^@/\s]+@/gi, "$1[REDACTED]@");
}
