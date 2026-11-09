/**
 * Narrow an optional manifest field to a string array.
 * @param subject - package or entry name used as the diagnostic prefix.
 * @param field - manifest field name used as the diagnostic suffix.
 * @param value - parsed manifest value.
 * @returns the array, or undefined when the field is absent.
 */
export function optionalStringArray(subject: string, field: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`client-modules: ${subject} ${field} must be a string array`)
  }
  return value as string[]
}
